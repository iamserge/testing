import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import { JitoAccounts } from "../jito/jito";
import { getPumpData, getTokenBalance } from "../../pumpfun/pumpfun";
import { bufferFromUInt64 } from "../../../utils/utils";
import { connection, wallet } from "../../../config";
import { BuyInsParam, ISwapTxResponse, SwapParam } from "../../../utils/types";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@raydium-io/raydium-sdk";
import {
  EVENT_AUTHORITY,
  GLOBAL,
  PUMP_FEE_RECIPIENT,
  PUMP_FUN_PROGRAM,
  RENT,
  TOKEN_DECIMALS,
} from "../../../utils/constants";
import { getLastValidBlockhash } from "../../sniper/getBlock";
import logger from "../../../logs/logger";

// Minimum token amount to prevent extremely small transactions
const MIN_TOKEN_AMOUNT = 1; // 1 lamport
// Minimum output amount as percentage of input
const MIN_OUTPUT_PERCENT = 0.0001; // 0.01% of input
// Balance difference tolerance for account closure verification
const BALANCE_TOLERANCE = 100; // Small amount to allow for rounding errors

/**
 * Helper function to get token short name for logs
 */
function getTokenShortName(mint: string): string {
  return `${mint.slice(0, 8)}...`;
}

/**
 * Creates and returns a swap transaction for PumpFun
 */
export const pumpfunSwap = async (
  swapParam: SwapParam
): Promise<ISwapTxResponse | null> => {
  const { mint, amount, slippage, tip, is_buy, isSellAll = false } = swapParam;
  const shortMint = getTokenShortName(mint);
  const operation = is_buy ? "BUY" : "SELL";
  
  logger.info(`[🧪 PUMPFUN-ATTEMPT] ${shortMint} | Preparing ${operation} transaction | Amount: ${amount.toFixed(6)}`);
  
  try {
    // Validate pumpData existence
    if (!swapParam.pumpData) {
      logger.error(`[❌ PUMPFUN-ERROR] ${shortMint} | Missing pump data, cannot create transaction`);
      return null;
    }
    
    // Get pump data from params
    const pumpData = swapParam.pumpData;
    
    // Validate critical pump data properties
    if (!pumpData.virtualSolReserves || !pumpData.virtualTokenReserves) {
      logger.error(`[❌ PUMPFUN-ERROR] ${shortMint} | Invalid pump data: virtualSolReserves=${pumpData.virtualSolReserves}, virtualTokenReserves=${pumpData.virtualTokenReserves}`);
      return null;
    }
    
    // Check for extremely small values in virtual reserves
    if (pumpData.virtualSolReserves < MIN_TOKEN_AMOUNT || pumpData.virtualTokenReserves < MIN_TOKEN_AMOUNT) {
      logger.error(`[❌ PUMPFUN-ERROR] ${shortMint} | Virtual reserves are too small, might cause calculation errors`);
      return null;
    }

    // Flag to determine if we should close the account in the same transaction
    let safeToCloseAccount = false;
    
    // SAFETY CHECK FOR SELL-ALL: Verify we're actually selling the full balance
    if (!is_buy && isSellAll) {
      try {
        // Get current token balance to verify
        const currentBalance = await getTokenBalance(
          wallet.publicKey.toBase58(),
          mint
        );
        
        // Check if the amount is close enough to the actual balance
        const amountIsComplete = Math.abs(currentBalance - amount) < BALANCE_TOLERANCE;
        
        if (!amountIsComplete) {
          logger.warn(`[⚠️ SAFETY-CHECK] ${shortMint} | isSellAll=true but amount (${amount}) doesn't match balance (${currentBalance}). Account closure will be handled separately.`);
          safeToCloseAccount = false;
        } else {
          logger.info(`[✓ BALANCE-VERIFIED] ${shortMint} | Selling the entire balance of ${amount} tokens. Safe to close account.`);
          safeToCloseAccount = true;
        }
      } catch (error: any) {
        logger.error(`[❌ BALANCE-CHECK-ERROR] ${shortMint} | Failed to verify token balance: ${error.message}`);
        safeToCloseAccount = false;
      }
    }

    const slippageValue = slippage / 100;
    const amountInLamports = is_buy
      ? Math.floor(amount * LAMPORTS_PER_SOL)
      : Math.floor(amount);
    
    logger.info(`[🔢 PUMPFUN-CALC] ${shortMint} | Slippage: ${slippage}%, AmountInLamports: ${amountInLamports}`);

    // Get or create token accounts
    const solAta = spl.getAssociatedTokenAddressSync(
      spl.NATIVE_MINT,
      wallet.publicKey,
      true
    );
    const splAta = spl.getAssociatedTokenAddressSync(
      new PublicKey(mint),
      wallet.publicKey,
      true
    );
    
    logger.info(`[🔑 PUMPFUN-ACCOUNTS] ${shortMint} | SOL ATA: ${solAta.toString().slice(0, 8)}... | Token ATA: ${splAta.toString().slice(0, 8)}...`);

    // Set up transaction keys
    const keys = [
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      {
        pubkey: pumpData.bondingCurve,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: pumpData.associatedBondingCurve,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: splAta, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: is_buy ? TOKEN_PROGRAM_ID : ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: is_buy ? RENT : TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
    ];

    let data: Buffer;
    let tokenOut = 0;
    let minSolOutput = 0;
    
    // Calculate swap amounts based on operation type
    if (is_buy) {
      // Calculate token output for buy operation
      try {
        tokenOut = Math.floor(
          (amountInLamports * pumpData.virtualTokenReserves) /
          pumpData.virtualSolReserves
        );
        
        // Verify calculated output is reasonable
        if (tokenOut < MIN_TOKEN_AMOUNT) {
          logger.error(`[❌ PUMPFUN-ERROR] ${shortMint} | Calculated tokenOut (${tokenOut}) is too small`);
          return null;
        }
        
        const solInWithSlippage = amount * (1 + slippageValue);
        const maxSolCost = Math.floor(solInWithSlippage * LAMPORTS_PER_SOL);
        
        logger.info(`[🔢 PUMPFUN-BUY-CALC] ${shortMint} | TokenOut: ${tokenOut} | MaxSolCost: ${maxSolCost / LAMPORTS_PER_SOL}`);
        
        data = Buffer.concat([
          bufferFromUInt64("16927863322537952870"),
          bufferFromUInt64(tokenOut),
          bufferFromUInt64(maxSolCost),
        ]);
      } catch (calcError: any) {
        logger.error(`[❌ PUMPFUN-CALC-ERROR] ${shortMint} | Error calculating buy amounts: ${calcError.message}`);
        return null;
      }
    } else {
      // Calculate SOL output for sell operation
      try {
        if (pumpData.virtualTokenReserves === 0) {
          logger.error(`[❌ PUMPFUN-ERROR] ${shortMint} | Virtual token reserves are zero, cannot calculate output`);
          return null;
        }
        
        minSolOutput = Math.floor(
          (amountInLamports *
            (1 - slippageValue) *
            pumpData.virtualSolReserves) /
            pumpData.virtualTokenReserves
        );
        
        // Check if output is reasonable - this affects whether we can safely close the account
        if (minSolOutput < MIN_TOKEN_AMOUNT) {
          logger.error(`[❌ PUMPFUN-ERROR] ${shortMint} | Calculated minSolOutput (${minSolOutput}) is too small`);
          safeToCloseAccount = false;
          return null;
        }
        
        // Check if the output seems unusually small relative to input (might indicate an issue)
        const outputRatio = minSolOutput / amountInLamports;
        if (outputRatio < MIN_OUTPUT_PERCENT) {
          logger.warn(`[⚠️ PUMPFUN-WARNING] ${shortMint} | Very low output ratio: ${(outputRatio * 100).toFixed(6)}% - may indicate issues`);
          // If output ratio is suspiciously low, don't close account in same transaction
          safeToCloseAccount = false;
        }
        
        logger.info(`[🔢 PUMPFUN-SELL-CALC] ${shortMint} | AmountIn: ${amountInLamports} | MinSolOutput: ${minSolOutput / LAMPORTS_PER_SOL}`);
        
        data = Buffer.concat([
          bufferFromUInt64("12502976635542562355"),
          bufferFromUInt64(amountInLamports),
          bufferFromUInt64(minSolOutput),
        ]);
      } catch (calcError: any) {
        logger.error(`[❌ PUMPFUN-CALC-ERROR] ${shortMint} | Error calculating sell amounts: ${calcError.message}`);
        return null;
      }
    }

    // Create the PumpFun instruction
    const pumpInstruction = new TransactionInstruction({
      keys,
      programId: PUMP_FUN_PROGRAM,
      data,
    });

    // Build transaction instructions
    const instructions: TransactionInstruction[] = is_buy
      ? [
          // Buy instructions
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 100000
          }),
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 300000
          }),
          spl.createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            solAta,
            wallet.publicKey,
            spl.NATIVE_MINT
          ),
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: solAta,
            lamports: amountInLamports,
          }),
          spl.createSyncNativeInstruction(solAta, TOKEN_PROGRAM_ID),
          spl.createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            splAta,
            wallet.publicKey,
            new PublicKey(mint)
          ),
          pumpInstruction,
          spl.createCloseAccountInstruction(
            solAta,
            wallet.publicKey,
            wallet.publicKey
          ),
        ]
      : [
          // Sell instructions
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 100000
          }),
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 300000
          }),
          spl.createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            splAta,
            wallet.publicKey,
            new PublicKey(mint)
          ),
          pumpInstruction,
        ];
    
    // Add tip for validator
    logger.info(`[💰 PUMPFUN-TIP] ${shortMint} | Adding tip: ${tip} SOL`);
    const feeInstructions = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new PublicKey(JitoAccounts[1]),
      lamports: tip * LAMPORTS_PER_SOL,
    });
    instructions.push(feeInstructions);

    // Only add close account instruction if we're confident it's safe
    if (!is_buy && isSellAll && safeToCloseAccount) {
      logger.info(`[🗑️ PUMPFUN-CLOSE-INLINE] ${shortMint} | Adding token account close instruction in same transaction`);
      instructions.push(
        spl.createCloseAccountInstruction(
          splAta,
          wallet.publicKey,
          wallet.publicKey
        )
      );
    } else if (!is_buy && isSellAll) {
      logger.info(`[🔒 PUMPFUN-CLOSE-DEFERRED] ${shortMint} | Will handle account closure separately after transaction confirmation`);
    }
    
    // Get recent blockhash and create transaction
    const blockhash = getLastValidBlockhash();
    if (!blockhash) {
      logger.error(`[❌ PUMPFUN-ERROR] ${shortMint} | Failed to get recent blockhash`);
      return null;
    }

    // Build transaction message
    logger.info(`[📝 PUMPFUN-TX] ${shortMint} | Building transaction with ${instructions.length} instructions`);
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    
    // Calculate decimal scale for return values
    const decimal = is_buy ? 10 ** TOKEN_DECIMALS : LAMPORTS_PER_SOL;
    
    // Create versioned transaction
    const vTxn = new VersionedTransaction(messageV0);
    const outAmount = is_buy
      ? Number(tokenOut) / decimal
      : Number(minSolOutput) / decimal;
    
    logger.info(`[✅ PUMPFUN-SUCCESS] ${shortMint} | Transaction created successfully | inAmount: ${amount.toFixed(6)}, outAmount: ${outAmount.toFixed(6)}`);
    
    return {
      vTxn,
      inAmount: amount,
      outAmount,
      // Return flag indicating if we need a separate account closing operation
      needsAccountClose: !is_buy && isSellAll && !safeToCloseAccount
    };
  } catch (error: any) {
    logger.error(`[❌ PUMPFUN-ERROR] ${shortMint} | Failed to create ${operation} transaction: ${error.message}`);
    if (error.stack) {
      logger.error(`[❌ PUMPFUN-STACK] ${shortMint} | ${error.stack.split('\n').slice(0, 3).join(' | ')}`);
    }
    return null;
  }
};

export function getBuyInstruction(buyParam: BuyInsParam) {
  try {
    const { mint, owner, bondingCurve, associatedBondingCurve, maxSol, splOut } = buyParam;
    const shortMint = getTokenShortName(mint.toBase58());
    
    logger.info(`[🔧 PUMPFUN-BUY-INST] ${shortMint} | Creating buy instruction | splOut: ${splOut}, maxSol: ${maxSol}`);

    // Get associated token address for the mint
    const tokenATA = spl.getAssociatedTokenAddressSync(mint, owner, true);

    // Create instruction to create the associated token account if it doesn't exist
    const createATAInstruction =
      spl.createAssociatedTokenAccountIdempotentInstruction(
        owner,
        tokenATA,
        owner,
        mint
      );

    // Keys for the transaction
    const buyKeys = [
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: tokenATA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: spl.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
    ];

    // Data for the transaction
    const buyData = Buffer.concat([
      bufferFromUInt64("16927863322537952870"), // Some ID (as string)
      bufferFromUInt64(splOut), // SPL amount out
      bufferFromUInt64(maxSol), // Max SOL
    ]);

    // Create the buy instruction
    const buyInstruction = new TransactionInstruction({
      keys: buyKeys,
      programId: PUMP_FUN_PROGRAM,
      data: buyData,
    });
    
    logger.info(`[✅ PUMPFUN-BUY-INST-SUCCESS] ${shortMint} | Buy instructions created successfully`);
    return [createATAInstruction, buyInstruction];
  } catch (error: any) {
    const shortMint = getTokenShortName(buyParam.mint.toBase58());
    logger.error(`[❌ PUMPFUN-BUY-INST-ERROR] ${shortMint} | Failed to create buy instructions: ${error.message}`);
    throw error;
  }
}