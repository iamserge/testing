import {
  VersionedTransaction,
  PublicKey,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import { ISwapTxResponse, SwapParam } from "../../utils/types";
import { connection, wallet } from "../../config";
import { JitoBundleService } from "./jito/jito";
import { 
  isRunning, 
  isWorkingTime, 
  simulateTxn
} from "../../utils/utils";
import { getLastValidBlockhash } from "../sniper/getBlock";
import { raydiumSwap } from "./raydium/raydiumSwap";
import { pumpfunSwap } from "./pumpfun/pumpfunSwap";
import { tokenClose } from "./tokenClose";
import { getCachedSolPrice } from "../sniper/getBlock";
import logger from "../../logs/logger";
import { getTokenBalance } from "../pumpfun/pumpfun";

// Constants for performance optimization
const DUST_AMOUNT_THRESHOLD = 0.0001; // Small amount threshold for burning
const FALLBACK_BURN_THRESHOLD = 0.001; // Higher threshold for fallback burn
const MAX_RETRY_ATTEMPTS = 2; // Maximum retry attempts for failed operations
const ACCOUNT_CLOSE_DELAY = 2000; // Delay before account closure in ms
const SIMULATION_CACHE_TTL = 5000; // Simulation cache time-to-live in ms

// Simulation cache to avoid redundant simulations
const simulationCache = new Map<string, {
  success: boolean;
  timestamp: number;
}>();

// Helper function for token name formatting
function getTokenShortName(mint: string): string {
  return `${mint.slice(0, 8)}...`;
}

// Helper to format amounts for logging
function formatAmount(value: number): string {
  return value.toFixed(value < 0.001 ? 8 : 6);
}

/**
 * Main swap function with optimizations:
 * 1. Balance verification before transaction creation
 * 2. Prioritized transaction execution
 * 3. Smart retry logic
 * 4. Simulation caching
 */
export const swap = async (
  swapParam: SwapParam
): Promise<ISwapTxResponse | null> => {
  const { mint, amount, is_buy, isSellAll = false } = swapParam;
  const shortMint = getTokenShortName(mint);
  const operation = is_buy ? "BUY" : "SELL";
  
  logger.info(`[🔄 SWAP-REQUEST] ${shortMint} | ${operation} | Amount: ${formatAmount(amount)}`);
  
  try {
    // For sell operations, verify token balance first to avoid simulation failures
    let adjustedAmount = amount;
    if (!is_buy) {
      try {
        const actualBalance = await getTokenBalance(wallet.publicKey.toBase58(), mint);
        if (actualBalance === 0) {
          logger.error(`[❌ BALANCE-ERROR] ${shortMint} | No tokens available to sell`);
          return null;
        }
        
        if (actualBalance < amount) {
          logger.warn(`[⚠️ BALANCE-WARNING] ${shortMint} | Requested amount (${formatAmount(amount)}) exceeds balance (${formatAmount(actualBalance)}), adjusting`);
          adjustedAmount = actualBalance;
          swapParam.amount = adjustedAmount;
        }
      } catch (error) {
        logger.error(`[❌ BALANCE-CHECK-ERROR] ${shortMint} | Error checking balance: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Initialize result variables
    let vTxn: VersionedTransaction | undefined;
    let inAmount = 0;
    let outAmount = 0;
    let price = 0;
    let needsAccountClose = false;
    let swapMethod = "";
    let retryCount = 0;
    
    // Check if tiny amount that should be burned instead of sold
    const shouldBurn = (!is_buy && adjustedAmount < DUST_AMOUNT_THRESHOLD);
    
    if (shouldBurn) {
      logger.info(`[🔥 BURN-DECISION] ${shortMint} | Amount ${formatAmount(adjustedAmount)} is below threshold, using token burn`);
      vTxn = await tokenClose(mint, adjustedAmount, isSellAll);
      swapMethod = "tokenClose";
      needsAccountClose = false;
      
      if (!vTxn) {
        logger.warn(`[⚠️ BURN-FAILED] ${shortMint} | Failed to create token burn transaction, falling back to regular swap`);
        swapMethod = ""; // Reset to try normal methods
      }
    }
    
    // Try standard swap methods with retries if burn not used or failed
    while (!swapMethod && retryCount <= MAX_RETRY_ATTEMPTS) {
      try {
        // Increase priority fees with each retry
        const priorityMultiplier = 1 + (retryCount * 0.5); // 1x, 1.5x, 2x
        const adjustedTip = swapParam.tip * priorityMultiplier;
        
        if (retryCount > 0) {
          logger.info(`[🔄 RETRY-${retryCount}] ${shortMint} | Attempt with higher priority (${priorityMultiplier}x) | Tip: ${adjustedTip.toFixed(6)} SOL`);
        }
        
        // Try PumpFun first
        const pumpParam = {...swapParam, tip: adjustedTip, amount: adjustedAmount};
        let swapResponse = await pumpfunSwap(pumpParam);
        
        if (swapResponse) {
          vTxn = swapResponse.vTxn;
          inAmount = swapResponse.inAmount;
          outAmount = swapResponse.outAmount;
          price = Number(swapParam.pumpData?.price || 0);
          swapMethod = "pumpfun";
          needsAccountClose = swapResponse.needsAccountClose || false;
          logger.info(`[✅ PUMPFUN-SUCCESS] ${shortMint} | Transaction created successfully`);
          break;
        }
        
        // If not buying and PumpFun failed, try Raydium
        if (!is_buy) {
          logger.info(`[⚠️ PUMPFUN-FAILED] ${shortMint} | Attempting raydiumSwap...`);
          swapResponse = await raydiumSwap(pumpParam);
          
          if (swapResponse) {
            vTxn = swapResponse.vTxn;
            inAmount = swapResponse.inAmount;
            outAmount = swapResponse.outAmount;
            price = Number(swapResponse.price || 0);
            swapMethod = "raydium";
            needsAccountClose = isSellAll;
            logger.info(`[✅ RAYDIUM-SUCCESS] ${shortMint} | Transaction created successfully`);
            break;
          }
        }
        
        // For small sell amounts, try burning as a last resort after first attempt
        if (!is_buy && adjustedAmount < FALLBACK_BURN_THRESHOLD && retryCount > 0) {
          logger.info(`[🔥 BURN-FALLBACK] ${shortMint} | Both swap methods failed. Attempting token burn as last resort.`);
          vTxn = await tokenClose(mint, adjustedAmount, isSellAll);
          
          if (vTxn) {
            swapMethod = "tokenClose_fallback";
            needsAccountClose = false;
            logger.info(`[✅ BURN-SUCCESS] ${shortMint} | Token burn transaction created successfully as fallback`);
            break;
          }
        }
        
        retryCount++;
        
        if (retryCount <= MAX_RETRY_ATTEMPTS) {
          // Wait with exponential backoff before retry
          const backoffMs = Math.min(500 * Math.pow(2, retryCount-1), 2000); // 500ms, 1000ms, 2000ms
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      } catch (error) {
        logger.error(`[❌ SWAP-CREATE-ERROR] ${shortMint} | Error in attempt ${retryCount+1}: ${error instanceof Error ? error.message : String(error)}`);
        retryCount++;
        
        // If we've exceeded retry attempts, break out
        if (retryCount > MAX_RETRY_ATTEMPTS) break;
        
        // Wait before retry with exponential backoff
        const backoffMs = Math.min(500 * Math.pow(2, retryCount-1), 2000);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
    
    // If we couldn't create a transaction after all attempts
    if (!vTxn) {
      logger.error(`[❌ ALL-METHODS-FAILED] ${shortMint} | Could not create transaction after ${retryCount} attempts`);
      return null;
    }
    
    // Add enhanced priority fees to the transaction
    vTxn = addPriorityFees(vTxn, is_buy ? "normal" : "high");
    
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
      logger.info(`[🚫 EXECUTION-BLOCKED] ${shortMint} | Not executing: running=${isRunning()}, workingTime=${isWorkingTime()}`);
    }
    
    if (shouldExecute) {
      try {
        // Simulate with caching to avoid redundant simulations
        const cacheKey = `${mint}-${swapMethod}-${inAmount}-${outAmount}`;
        logger.info(`[🧪 SIMULATING] ${shortMint} | Simulating transaction`);
        
        const simulationSuccess = await simulateTxnWithCache(vTxn, cacheKey);
        if (!simulationSuccess) {
          logger.error(`[❌ SIMULATION-FAILED] ${shortMint} | Transaction simulation failed`);
          return null;
        }
        
        logger.info(`[✅ SIMULATION-SUCCESS] ${shortMint} | Transaction simulation successful`);
        
        // Execute and confirm the transaction
        logger.info(`[🚀 EXECUTING] ${shortMint} | Sending transaction to network`);
        const result = await confirmTxWithRetry(vTxn, mint);
        
        if (!result) {
          logger.error(`[❌ CONFIRMATION-FAILED] ${shortMint} | Transaction confirmation failed`);
          return null;
        }
        
        const { txHash } = result;
        logger.info(`[✅ SWAP-COMPLETE] ${shortMint} | ${operation} | Method: ${swapMethod} | TxHash: ${txHash.slice(0, 8)}...`);
        
        // Handle account closure as needed
        let closeAccountTxHash = null;
        if (!is_buy && isSellAll && needsAccountClose) {
          logger.info(`[🔒 FOLLOW-UP] ${shortMint} | Proceeding with account closure in separate transaction`);
          
          // Wait briefly to ensure the swap transaction is fully processed
          await new Promise(resolve => setTimeout(resolve, ACCOUNT_CLOSE_DELAY));
          
          closeAccountTxHash = await handleAccountClosure(mint);
          if (closeAccountTxHash) {
            logger.info(`[✅ CLOSE-COMPLETE] ${shortMint} | Account closed successfully: ${closeAccountTxHash.slice(0, 8)}...`);
          }
        }
        const solPrice = getCachedSolPrice();

        // For burn operations, set appropriate values
        if (swapMethod.includes("tokenClose")) {
          logger.info(`[🔥 BURN-COMPLETE] ${shortMint} | Token successfully burned | Amount: ${formatAmount(adjustedAmount)}`);
          
          return {
            txHash,
            price: is_buy ? 0 : price || solPrice,
            inAmount: adjustedAmount,
            outAmount: 0,
            closeAccountTxHash,
            vTxn, // Add the transaction object
            needsAccountClose: true // Add needsAccountClose property
          };
        }

        return {
          txHash,
          price: is_buy ? 0 : price || solPrice,
          inAmount: adjustedAmount,
          outAmount: 0,
          closeAccountTxHash,
          vTxn, // Add the transaction object
          needsAccountClose: false // Add needsAccountClose property
        };
      } catch (error) {
        logger.error(`[❌ EXECUTION-ERROR] ${shortMint} | Transaction execution failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
    
    logger.info(`[🚫 NOT-EXECUTED] ${shortMint} | Transaction prepared but not executed due to operating conditions`);
    return null;
  } catch (error: any) {
    logger.error(`[❌ SWAP-ERROR] ${shortMint} | Error in swap function: ${error.message}`);
    return null;
  }
};

/**
 * Add priority fees to a transaction
 */
function addPriorityFees(
  vTxn: VersionedTransaction, 
  priorityLevel: "low" | "normal" | "high" = "normal"
): VersionedTransaction {
  try {
    // Clone the transaction message
    const message = TransactionMessage.decompile(vTxn.message);
    
    // Priority fees by level (microLamports)
    const priorityFees = {
      low: 200000,
      normal: 500000,
      high: 1000000
    };
    
    // Compute units by priority level
    const computeUnits = {
      low: 200000,
      normal: 300000,
      high: 400000
    };
    
    // Remove any existing compute budget instructions
    const nonComputeInstructions = message.instructions.filter(
      inst => !inst.programId.equals(ComputeBudgetProgram.programId)
    );
    
    // Add new compute budget instructions at the beginning
    const newInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnits[priorityLevel]
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFees[priorityLevel]
      }),
      ...nonComputeInstructions
    ];
    
    // Recompile message with new instructions
    const newMessage = new TransactionMessage({
      payerKey: message.payerKey,
      recentBlockhash: message.recentBlockhash,
      instructions: newInstructions
    }).compileToV0Message();
    
    // Create new transaction with updated message
    return new VersionedTransaction(newMessage);
  } catch (error) {
    logger.error(`[❌ PRIORITY-ERROR] Error adding priority fees: ${error instanceof Error ? error.message : String(error)}`);
    return vTxn; // Return original transaction if enhancement fails
  }
}

/**
 * Simulate transaction with caching
 */
async function simulateTxnWithCache(
  txn: VersionedTransaction,
  cacheKey: string
): Promise<boolean> {
  // Check cache first
  const cachedResult = simulationCache.get(cacheKey);
  if (cachedResult && Date.now() - cachedResult.timestamp < SIMULATION_CACHE_TTL) {
    return cachedResult.success;
  }
  
  try {
    const { value } = await connection.simulateTransaction(txn, {
      replaceRecentBlockhash: true,
      commitment: "processed",
    });
    
    const success = !value.err;
    
    // Cache the result
    simulationCache.set(cacheKey, {
      success,
      timestamp: Date.now()
    });
    
    // If success is false (simulation failed), log the error details
    if (!success) {
      logger.error(`Simulation error: ${JSON.stringify(value.err)}`);
    }
    
    return success;
  } catch (error) {
    logger.error(`Simulation error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Confirm transaction with retry logic
 */
async function confirmTxWithRetry(
  txn: VersionedTransaction,
  mint: string,
  maxRetries: number = 1
): Promise<{txHash: string} | null> {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Wait with exponential backoff between retries
      if (attempt > 0) {
        const backoffMs = 1000 * Math.pow(2, attempt-1);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
      
      const result = await confirmVtxn(txn, mint);
      if (!result) {
        throw new Error("Transaction confirmation failed");
      }
      return result;
    } catch (error) {
      lastError = error;
      logger.warn(`Confirmation attempt ${attempt+1}/${maxRetries+1} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  logger.error(`All confirmation attempts failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  return null;
}

/**
 * Handle account closure in a separate transaction
 */
async function handleAccountClosure(mint: string): Promise<string | null> {
  const shortMint = getTokenShortName(mint);
  
  try {
    // Verify the account is empty first
    const remainingBalance = await getTokenBalance(wallet.publicKey.toBase58(), mint);
    
    if (remainingBalance > 0) {
      logger.warn(`[⚠️ SAFETY-ABORT] ${shortMint} | Account not empty (${remainingBalance} tokens remain). Aborting closure.`);
      return null;
    }
    
    // Create token account
    const splAta = spl.getAssociatedTokenAddressSync(
      new PublicKey(mint),
      wallet.publicKey,
      true
    );
    
    // Create close account instruction
    const closeAccountInst = spl.createCloseAccountInstruction(
      splAta,
      wallet.publicKey,
      wallet.publicKey
    );
    
    // Get recent blockhash
    const blockhash = getLastValidBlockhash();
    if (!blockhash) {
      logger.error(`[❌ CLOSE-ERROR] ${shortMint} | Failed to get blockhash for account closure`);
      return null;
    }
    
    // Create transaction message
    const closeMsg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [closeAccountInst],
    }).compileToV0Message();
    
    // Create and sign transaction
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
    
    // Send and confirm transaction
    const result = await confirmVtxn(closeTx, mint);
    if (!result) {
      logger.error(`[❌ CLOSE-FAILED] ${shortMint} | Failed to confirm account closure transaction`);
      return null;
    }
    
    return result.txHash;
  } catch (error) {
    logger.error(`[❌ CLOSE-ERROR] ${shortMint} | Error closing account: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Confirms a versioned transaction with Jito bundle service
 * Enhanced with better error handling
 */
export async function confirmVtxn(txn: VersionedTransaction, mint: string): Promise<{txHash: string} | null> {
  const shortMint = getTokenShortName(mint);
  const startTime = Date.now();
  const CONFIRM_TIMEOUT_MS = 30000; // 30 seconds max wait
  
  try {
    const rawTxn = txn.serialize();
    const jitoBundleInstance = new JitoBundleService();

    logger.info(`[🔶 JITO] ${shortMint} | Sending transaction to Jito service`);
    
    const txHash = await jitoBundleInstance.sendTransaction(rawTxn);
    if (!txHash) {
      throw new Error("Failed to get transaction hash from Jito service");
    }

    logger.info(`[🔶 JITO] ${shortMint} | Transaction sent, hash: ${txHash.slice(0, 8)}...`);

    // Set up confirmation with timeout
    const confirmationPromise = connection.confirmTransaction(txHash);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Transaction confirmation timeout")), CONFIRM_TIMEOUT_MS)
    );
    
    // Race between confirmation and timeout
    const txRlt = await Promise.race([confirmationPromise, timeoutPromise]);
    
    // Add type guard to check that txRlt has the expected structure
    if (txRlt && typeof txRlt === 'object' && 'value' in txRlt && txRlt.value && 
        typeof txRlt.value === 'object' && 'err' in txRlt.value) {
      if (txRlt.value.err) {
        logger.error(`[❌ TX-ERROR] ${shortMint} | Transaction confirmation failed: ${JSON.stringify(txRlt.value.err)}`);
        return null;
      }
    } else {
      logger.error(`[❌ TX-ERROR] ${shortMint} | Unexpected transaction confirmation response format`);
      return null;
    }

    const confirmTime = Date.now() - startTime;
    logger.info(`[✅ CONFIRMED] ${shortMint} | Transaction confirmed in ${confirmTime}ms: ${txHash.slice(0, 8)}...`);
    return { txHash };
  } catch (error: any) {
    const errorTime = Date.now() - startTime;
    logger.error(`[❌ JITO-ERROR] ${shortMint} | confirmVtxn error after ${errorTime}ms: ${error.message}`);
    return null;
  }
}