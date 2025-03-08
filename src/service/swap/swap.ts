import { VersionedTransaction } from "@solana/web3.js";
import { connection, wallet } from "../../config";
import { ISwapHashResponse, SwapParam } from "../../utils/types";
import { JitoBundleService } from "./jito/jito";
import { isRunning, isWorkingTime, simulateTxn } from "../../utils/utils";
import { raydiumSwap } from "./raydium/raydiumSwap";
import { pumpfunSwap } from "./pumpfun/pumpfunSwap";
import logger from "../../logs/logger";
import { tokenClose } from "./tokenClose";
import { getCachedSolPrice } from "../sniper/getBlock";
import * as spl from "@solana/spl-token";
import { PublicKey, TransactionMessage } from "@solana/web3.js";
import { getTokenBalance } from "../pumpfun/pumpfun";
import { getLastValidBlockhash } from "../sniper/getBlock";

// Small amount threshold for automatic burning instead of selling (in token units)
const DUST_AMOUNT_THRESHOLD = 0.0001;
// Higher threshold for fallback burn attempts when other methods fail
const FALLBACK_BURN_THRESHOLD = 0.001;
// Max retries for swap operations
const MAX_SWAP_RETRIES = 2;
// Account close confirmation delay in ms to ensure swap has been processed
const ACCOUNT_CLOSE_DELAY = 2000;

// Helper function to get token short name for logs
function getTokenShortName(mint: string): string {
  return `${mint.slice(0, 8)}...`;
}

// Helper function to format currency values
function formatUSD(value: number): string {
  return `$${value.toFixed(6)}`;
}

// Helper function to format token amounts
function formatTokenAmount(amount: number): string {
  return amount.toFixed(amount < 0.001 ? 8 : 6);
}

/**
 * Confirms a versioned transaction with Jito bundle service
 * @param txn The transaction to confirm
 * @param mint The token mint for logging
 * @returns Transaction hash or null if failed
 */
export async function confirmVtxn(txn: VersionedTransaction, mint: string) {
  const shortMint = getTokenShortName(mint);
  const startTime = Date.now();
  const CONFIRM_TIMEOUT_MS = 30000; // 30 seconds max wait
  
  try {
    const rawTxn = txn.serialize();
    const jitoBundleInstance = new JitoBundleService();

    logger.info(`[🔶 JITO] ${shortMint} | Sending transaction to Jito service`);
    const txHash = await jitoBundleInstance.sendTransaction(rawTxn);

    logger.info(`[🔶 JITO] ${shortMint} | Transaction sent, hash: ${txHash.slice(0, 8)}...`);

    // Set up confirmation with timeout
    const confirmationPromise = connection.confirmTransaction(txHash);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Transaction confirmation timeout")), CONFIRM_TIMEOUT_MS)
    );
    
    // Race between confirmation and timeout
    const txRlt = await Promise.race([confirmationPromise, timeoutPromise]);
    // Add type guard to check that txRlt has the expected structure
    if (txRlt && typeof txRlt === 'object' && 'value' in txRlt && txRlt.value && typeof txRlt.value === 'object' && 'err' in txRlt.value) {
      if (txRlt.value.err) {
        logger.error(`[❌ TX-ERROR] ${shortMint} | Transaction confirmation failed: ${JSON.stringify(txRlt.value.err)}`);
        return null;
      }
    } else {
      logger.error(`[❌ TX-ERROR] ${shortMint} | Unexpected transaction confirmation response format`);
      return null;
    }

    logger.info(`[✅ CONFIRMED] ${shortMint} | Transaction confirmed successfully: ${txHash.slice(0, 8)}...`);
    return { txHash };
  } catch (error: any) {
    logger.error(`[❌ JITO-ERROR] ${shortMint} | confirmVtxn error: ${error.message}`);
    return null;
  }
}

/**
 * Handle the account closure as a separate transaction for safety
 */
async function handleAccountClosure(mint: string) {
  const shortMint = getTokenShortName(mint);
  
  // Wait a bit to ensure the swap transaction has been fully processed
  await new Promise(resolve => setTimeout(resolve, ACCOUNT_CLOSE_DELAY));
  
  try {
    // Verify the account is actually empty
    const remainingBalance = await getTokenBalance(wallet.publicKey.toBase58(), mint);
    
    if (remainingBalance > 0) {
      logger.warn(`[⚠️ SAFETY-ABORT] ${shortMint} | Account not empty (${remainingBalance} tokens remain). Aborting account closure.`);
      return null;
    }
    
    logger.info(`[✓ EMPTY-ACCOUNT] ${shortMint} | Account is empty. Proceeding with closure.`);
    
    // Create a separate transaction just for account closure
    const splAta = spl.getAssociatedTokenAddressSync(
      new PublicKey(mint),
      wallet.publicKey,
      true
    );
    
    const closeAccountInst = spl.createCloseAccountInstruction(
      splAta,
      wallet.publicKey,
      wallet.publicKey
    );
    
    // Create and send the transaction
    const blockhash = getLastValidBlockhash();
    if (!blockhash) {
      logger.error(`[❌ CLOSE-ERROR] ${shortMint} | Failed to get blockhash for account closure`);
      return null;
    }
    
    const closeMsg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [closeAccountInst],
    }).compileToV0Message();
    
    const closeTx = new VersionedTransaction(closeMsg);
    closeTx.sign([wallet]);
    
    // Simulate before sending
    try {
      await simulateTxn(closeTx);
      logger.info(`[✓ CLOSE-SIMULATION] ${shortMint} | Account closure simulation successful`);
    } catch (simError) {
      logger.error(`[❌ CLOSE-SIM-ERROR] ${shortMint} | Account closure simulation failed: ${simError}`);
      return null;
    }
    
    const closeResult = await confirmVtxn(closeTx, mint);
    if (closeResult) {
      logger.info(`[✅ ACCOUNT-CLOSED] ${shortMint} | Token account successfully closed in separate transaction`);
      return closeResult.txHash;
    } else {
      logger.error(`[❌ CLOSE-FAILED] ${shortMint} | Failed to close token account in follow-up operation`);
      return null;
    }
  } catch (error: any) {
    logger.error(`[❌ CLOSE-ERROR] ${shortMint} | Error in follow-up account closure: ${error.message}`);
    return null;
  }
}

/**
 * Main swap function for buying or selling tokens
 * Enhanced with better logging and automatic dust handling
 */
export const swap = async (
  swapParam: SwapParam
): Promise<ISwapHashResponse | null> => {
  const { mint, amount, is_buy, isSellAll = false } = swapParam;
  const shortMint = getTokenShortName(mint);
  const operation = is_buy ? "BUY" : "SELL";

  logger.info(`[🔄 SWAP-REQUEST] ${shortMint} | ${operation} | Amount: ${formatTokenAmount(amount)} | isSellAll: ${isSellAll}`);

  try {
    let vTxn;
    let inAmount = 0; // without decimals
    let outAmount = 0; // without decimals
    let price = 0;
    let swapMethod = ""; // Track which method was used
    let retryCount = 0;
    let needsAccountClose = false;

    // Determine if we should burn the tokens instead of selling
    // Either because amount is extremely small (dust) regardless of isSellAll flag
    const shouldBurn = (!is_buy && amount < DUST_AMOUNT_THRESHOLD);

    if (shouldBurn) {
      logger.info(`[🔥 BURN-DECISION] ${shortMint} | Amount ${formatTokenAmount(amount)} is below threshold ${DUST_AMOUNT_THRESHOLD}. Using token burn.`);
      vTxn = await tokenClose(mint, amount, isSellAll);
      swapMethod = "tokenClose";
      
      // Set this to false since we're already burning tokens
      needsAccountClose = false;

      // If we couldn't create a burn transaction, log the error and try regular swap
      if (!vTxn) {
        logger.warn(`[⚠️ BURN-FAILED] ${shortMint} | Failed to create token burn transaction. Falling back to regular swap.`);
        swapMethod = ""; // Reset so we try regular swap methods
      }
    }

    // If not burning or burn transaction creation failed, try regular swap methods
    while (!swapMethod && retryCount < MAX_SWAP_RETRIES) {
      // Try using pumpfunSwap first
      logger.info(`[🧪 ATTEMPT] ${shortMint} | Attempt ${retryCount + 1}/${MAX_SWAP_RETRIES} | Using pumpfunSwap for ${operation}`);

      let swapResponse = await pumpfunSwap(swapParam);

      if (swapResponse) {
        vTxn = swapResponse.vTxn;
        inAmount = swapResponse.inAmount;
        outAmount = swapResponse.outAmount;
        price = Number(swapParam.pumpData?.price);
        swapMethod = "pumpfun";
        // Check if we need a separate account closure operation
        needsAccountClose = swapResponse.needsAccountClose || false;
        logger.info(`[✅ PUMPFUN-SUCCESS] ${shortMint} | inAmount: ${formatTokenAmount(inAmount)}, outAmount: ${formatTokenAmount(outAmount)}, price: ${formatUSD(price)}`);
        break;
      } else if (!is_buy) {
        // If it's a sell and pumpfun failed, try raydium
        logger.info(`[⚠️ PUMPFUN-FAILED] ${shortMint} | Token may be in raydium, attempting raydiumSwap...`);
        swapResponse = await raydiumSwap(swapParam);

        if (swapResponse) {
          vTxn = swapResponse.vTxn;
          inAmount = swapResponse.inAmount;
          outAmount = swapResponse.outAmount;
          price = Number(swapResponse.price);
          swapMethod = "raydium";
          // Raydium also needs account closure handling
          needsAccountClose = isSellAll;
          logger.info(`[✅ RAYDIUM-SUCCESS] ${shortMint} | inAmount: ${formatTokenAmount(inAmount)}, outAmount: ${formatTokenAmount(outAmount)}, price: ${formatUSD(price)}`);
          break;
        } else {
          logger.error(`[❌ RAYDIUM-FAILED] ${shortMint} | Failed to create raydium swap transaction`);

          // As a last resort for small amounts that failed with both methods, try burning
          if (amount < FALLBACK_BURN_THRESHOLD) {
            logger.info(`[🔥 BURN-FALLBACK] ${shortMint} | Both swap methods failed. Attempting token burn as last resort.`);
            vTxn = await tokenClose(mint, amount, isSellAll);

            if (vTxn) {
              swapMethod = "tokenClose_fallback";
              // No need for separate account closure since tokenClose burns and closes
              needsAccountClose = false;
              logger.info(`[✅ BURN-SUCCESS] ${shortMint} | Token burn transaction created successfully as fallback`);
              break;
            } else {
              logger.error(`[❌ BURN-FAILED] ${shortMint} | Fallback burn attempt failed`);
            }
          }
        }
      }

      retryCount++;
      if (retryCount < MAX_SWAP_RETRIES) {
        logger.info(`[🔄 RETRY] ${shortMint} | Retrying swap operation (${retryCount}/${MAX_SWAP_RETRIES})`);
      }
    }

    if (!vTxn) {
      logger.error(`[❌ ALL-METHODS-FAILED] ${shortMint} | Could not create transaction using any method after ${retryCount} attempts`);
      return null;
    }

    // Sign the transaction
    vTxn.sign([wallet]);
    logger.info(`[✍️ SIGNED] ${shortMint} | Transaction signed using ${swapMethod} method`);

    // Determine if we should proceed with execution
    let shouldExecute = false;
    if (is_buy && isRunning() && isWorkingTime()) {
      shouldExecute = true;
      logger.info(`[⚙️ EXECUTION-CHECK] ${shortMint} | Bot is running and within working hours. Proceeding with buy.`);
    } else if (!is_buy) {
      shouldExecute = true;
      logger.info(`[⚙️ EXECUTION-CHECK] ${shortMint} | Sell operation allowed at any time. Proceeding.`);
    } else {
      logger.info(`[🚫 EXECUTION-BLOCKED] ${shortMint} | Not executing transaction: running=${isRunning()}, workingTime=${isWorkingTime()}`);
    }

    if (shouldExecute) {
      try {
        // Simulate the transaction first
        logger.info(`[🧪 SIMULATING] ${shortMint} | Simulating transaction before submission`);
        await simulateTxn(vTxn);
        logger.info(`[✅ SIMULATION-SUCCESS] ${shortMint} | Transaction simulation successful`);
        
        // Confirm the transaction
        const result = await confirmVtxn(vTxn, mint);
        if (!result) {
          logger.error(`[❌ CONFIRMATION-FAILED] ${shortMint} | Transaction confirmation failed`);
          return null;
        }
        
        const { txHash } = result;
        logger.info(`[✅ SWAP-COMPLETE] ${shortMint} | ${operation} | Method: ${swapMethod} | TxHash: ${txHash.slice(0, 8)}...`);
        
        // Handle account closure as a separate transaction if needed
        let closeAccountTxHash = null;
        if (!is_buy && isSellAll && needsAccountClose) {
          logger.info(`[🔒 FOLLOW-UP] ${shortMint} | Proceeding with account closure in separate transaction`);
          closeAccountTxHash = await handleAccountClosure(mint);
          
          if (closeAccountTxHash) {
            logger.info(`[✅ CLOSE-COMPLETE] ${shortMint} | Account closed successfully in separate transaction: ${closeAccountTxHash.slice(0, 8)}...`);
          }
        }

        // For burn operations, set reasonable defaults for the response
        if (swapMethod.includes("tokenClose")) {
          const solPrice = getCachedSolPrice();
          logger.info(`[🔥 BURN-COMPLETE] ${shortMint} | Token successfully burned | Amount: ${formatTokenAmount(amount)}`);
          return {
            txHash,
            price: is_buy ? 0 : price || solPrice, // Use cached SOL price as fallback
            inAmount: amount,
            outAmount: 0, // For burn operations, there's no output amount
            closeAccountTxHash // Include close account txn hash if available
          };
        }

        return { 
          txHash, 
          price, 
          inAmount, 
          outAmount,
          closeAccountTxHash // Include close account txn hash if available
        };
      } catch (error: any) {
        logger.error(`[❌ EXECUTION-ERROR] ${shortMint} | Transaction execution failed: ${error.message}`);
        return null;
      }
    }

    logger.info(`[🚫 NOT-EXECUTED] ${shortMint} | Transaction prepared but not executed due to operating conditions`);
    return null;
  } catch (error: any) {
    logger.error(`[❌ SWAP-ERROR] ${shortMint} | Error in swap function: ${error.message}`);
    if (error.stack) {
      logger.error(`[❌ STACK-TRACE] ${shortMint} | ${error.stack.split('\n').slice(0, 3).join(' | ')}`);
    }
    return null;
  }
};