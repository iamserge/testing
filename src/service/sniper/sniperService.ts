import { Commitment, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connection, metaplex, START_TXT, wallet } from "../../config";
import { SniperBotConfig } from "../setting/botConfigClass";
import { getPumpData, getTokenBalance } from "../pumpfun/pumpfun";
import { PUMPFUN_IMG, TOKEN_DECIMALS, TOTAL_SUPPLY } from "../../utils/constants";
import { swap } from "../swap/swap";
import { saveTXonDB } from "../tx/TxService";
import { getCachedSolPrice } from "./getBlock";
import logger from "../../logs/logger";
import { SwapParam, ITxntmpData, IAlertMsg, PumpData } from "../../utils/types";
import {
  isRunning,
  isWorkingTime,
  getDexscreenerData,
} from "../../utils/utils";
import chalk from "chalk";
import { DBTokenList, IToken } from "../../models/TokenList";
import { getWalletBalanceFromCache } from "./getWalletBalance";
import { createAlert } from "../alarm/alarm";
import { WssMonitorService } from "./wssMonitorService";
import { tokenMonitorThread2Sell } from "./sellMonitorService";
import { USE_WSS } from "../../index";
import { ITransaction } from "../../models/SniperTxns";

// Constants
const PUMP_WALLET = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const COMMITMENT_LEVEL = "confirmed" as Commitment;
let BUY_MONITOR_CYCLE = SniperBotConfig.getBuyIntervalTime();

// Max time to wait for transaction data (milliseconds)
const TX_FETCH_TIMEOUT = 7000;

// Common Solana error codes and their meanings
const ERROR_CODES: Record<string, string> = {
  "Custom:3007": "Insufficient funds",
  "Custom:6001": "Invalid instruction data",
  "Custom:6002": "Invalid account data",
  "Custom:6003": "Account not initialized",
  "Custom:6005": "Account already in use",
  "Custom:6020": "Account not owned by program",
  "Custom:6023": "Invalid account owner",
  "Custom:3012": "Transaction error",
  "IllegalOwner": "Invalid account owner",
  "ProgramFailedToComplete": "Program execution failed",
  "InvalidAccountData": "Invalid account data format"
};

// Track tokens being monitored
const tokenBuyingMap: Map<string, number> = new Map();
// Track processed transaction signatures to avoid duplicates
const processedSignatures: Set<string> = new Set();
// Rate limiting for log processing
let lastLogProcessTime = 0;
const MIN_LOG_PROCESS_INTERVAL = 100; // milliseconds

export const removeTokenBuyingMap = (value: string) => {
  logger.info(`[🔄 BUYING-MAP] Removing token ${value.slice(0, 8)}... from buying map`);
  tokenBuyingMap.delete(value);
};

/**
 * Helper function to format error messages from Solana
 * @param error The error object from Solana
 * @returns Formatted error message
 */
function formatSolanaError(error: any): string {
  console.log(JSON.stringify(error))
  try {
    if (typeof error === 'string') {
      return error;
    }

    if (typeof error === 'object') {
      if (error.InstructionError) {
        const [index, errorDetail] = error.InstructionError;
        
        if (typeof errorDetail === 'string') {
          const errorKey = errorDetail as string;
          return `Instruction ${index} failed: ${errorDetail} (${ERROR_CODES[errorKey] || 'Unknown error'})`;
        } else if (typeof errorDetail === 'object' && errorDetail.Custom !== undefined) {
          const errorCode = `Custom:${errorDetail.Custom}`;
          return `Instruction ${index} failed: Custom error ${errorDetail.Custom} (${ERROR_CODES[errorCode] || 'Unknown custom error'})`;
        }
      }
      
      return JSON.stringify(error);
    }
    
    return 'Unknown error format';
  } catch (e) {
    return `Error parsing error: ${e}`;
  }
}

/**
 * Validates a token based on bot configuration
 * Enhanced with detailed logging
 */
export const validateToken = async (mint: string, dev: PublicKey) => {
  const shortMint = mint.slice(0, 8) + '...';
  logger.info(`[🔍 VALIDATE] ${shortMint} | Starting token validation`);
  
  try {
    let pumpid = 0;
    let devHoldingId = 0;
    let allAccountsId = 0;
    let dexScreenerId = 0;
    const botBuyConfig = SniperBotConfig.getBuyConfig();

    const promiseArray: any[] = [];
    logger.info(`[🔍 VALIDATE] ${shortMint} | Fetching PumpData`);
    promiseArray.push(getPumpData(new PublicKey(mint)));
    
    if (botBuyConfig.maxDevHoldingAmount.enabled) {
      logger.info(`[🔍 VALIDATE] ${shortMint} | Checking developer holdings`);
      promiseArray.push(getTokenBalance(dev.toString(), mint));
      devHoldingId = promiseArray.length - 1;
    }

    if (botBuyConfig.holders.enabled) {
      logger.info(`[🔍 VALIDATE] ${shortMint} | Checking token holders`);
      promiseArray.push(
        connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
          filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
        })
      );
      allAccountsId = promiseArray.length - 1;
    }
    
    if (
      botBuyConfig.lastHourVolume.enabled ||
      botBuyConfig.lastMinuteTxns.enabled
    ) {
      logger.info(`[🔍 VALIDATE] ${shortMint} | Checking trading activity`);
      promiseArray.push(getDexscreenerData(mint));
      dexScreenerId = promiseArray.length - 1;
    }

    const validationStart = Date.now();
    logger.info(`[🔍 VALIDATE] ${shortMint} | Awaiting all validation checks...`);
    
    // Use Promise.allSettled to ensure all promises complete even if some fail
    const promiseResults = await Promise.allSettled(promiseArray);
    const validationTime = Date.now() - validationStart;
    
    // Extract results from settled promises, handling failures gracefully
    const pumpDataResult = promiseResults[pumpid];
    const pumpData = pumpDataResult.status === 'fulfilled' ? pumpDataResult.value : null;

    let _devHolding = 0;
    if (devHoldingId !== 0) {
      const devHoldingResult = promiseResults[devHoldingId];
      if (devHoldingResult && devHoldingResult.status === 'fulfilled') {
        _devHolding = devHoldingResult.value;
      }
    }

    let allAccounts = { length: 0 };
    if (botBuyConfig.holders.enabled) {
      const allAccountsResult = promiseResults[allAccountsId];
      if (allAccountsResult && allAccountsResult.status === 'fulfilled') {
        allAccounts = allAccountsResult.value;
      }
    }

    let dexData = null;
    if (botBuyConfig.lastHourVolume.enabled || botBuyConfig.lastMinuteTxns.enabled) {
      const dexDataResult = promiseResults[dexScreenerId];
      if (dexDataResult && dexDataResult.status === 'fulfilled') {
        dexData = dexDataResult.value;
      }
    }

    // If PumpData fetch failed, we can't proceed
    if (!pumpData) {
      logger.error(`[❌ VALIDATE-ERROR] ${shortMint} | Failed to fetch pump data`);
      return { isValid: false, pumpData: null };
    }

    // Market cap validation
    const _mc = Number(pumpData?.marketCap || 0);
    const _holders = allAccounts?.length || 0;
    let isValid = true;
    
    logger.info(`[🔍 VALIDATE] ${shortMint} | Market cap: $${_mc.toFixed(2)}, Holders: ${_holders}`);
    
    // Validate against criteria
    if (
      botBuyConfig.marketCap.enabled &&
      !(botBuyConfig.marketCap.min <= _mc && _mc <= botBuyConfig.marketCap.max)
    ) {
      logger.info(`[❌ INVALID] ${shortMint} | Market cap outside range: $${_mc.toFixed(2)} (range: $${botBuyConfig.marketCap.min}-$${botBuyConfig.marketCap.max})`);
      isValid = false;
    }
    
    if (
      botBuyConfig.maxDevHoldingAmount.enabled &&
      Number(_devHolding || 0) >
        (TOTAL_SUPPLY / 100) * botBuyConfig.maxDevHoldingAmount.value
    ) {
      logger.info(`[❌ INVALID] ${shortMint} | Developer holding too high: ${Number(_devHolding || 0)} tokens`);
      isValid = false;
    }
    
    if (botBuyConfig.holders.enabled && _holders < botBuyConfig.holders.value) {
      logger.info(`[❌ INVALID] ${shortMint} | Not enough holders: ${_holders} (min: ${botBuyConfig.holders.value})`);
      isValid = false;
    }

    if (
      botBuyConfig.lastHourVolume.enabled ||
      botBuyConfig.lastMinuteTxns.enabled
    ) {
      if (!dexData || !dexData[0]) {
        logger.info(`[❌ INVALID] ${shortMint} | No DexScreener data available`);
        isValid = false;
      } else {
        const dexScreenerData = dexData[0];
        
        if (!dexScreenerData.volume || !dexScreenerData.volume.h1) {
          logger.info(`[❌ INVALID] ${shortMint} | No hourly volume data available`);
          isValid = false;
        } else if (
          botBuyConfig.lastHourVolume.enabled &&
          dexScreenerData.volume.h1 < botBuyConfig.lastHourVolume.value
        ) {
          logger.info(`[❌ INVALID] ${shortMint} | Hour volume too low: $${dexScreenerData.volume.h1} (min: $${botBuyConfig.lastHourVolume.value})`);
          isValid = false;
        }
        
        if (dexScreenerData.txns && dexScreenerData.txns.h1) {
          const _txns = dexScreenerData.txns.h1.buys + dexScreenerData.txns.h1.sells || 0;
          if (
            botBuyConfig.lastMinuteTxns.enabled &&
            _txns < botBuyConfig.lastMinuteTxns.value
          ) {
            logger.info(`[❌ INVALID] ${shortMint} | Not enough transactions: ${_txns} (min: ${botBuyConfig.lastMinuteTxns.value})`);
            isValid = false;
          }
        }
      }
    }

    logger.info(`[🔍 VALIDATE] ${shortMint} | Validation completed in ${validationTime}ms: ${isValid ? '✅ Valid' : '❌ Invalid'}`);
    return { isValid, pumpData };
  } catch (error) {
    logger.error(`[❌ VALIDATE-ERROR] ${shortMint} | Token validation error: ${error instanceof Error ? error.message : String(error)}`);
    return { isValid: false, pumpData: null };
  }
};

/**
 * Check if a token symbol already exists in the database
 * Enhanced with robust error handling and logging
 */
const checkDuplicates = async (mint: string): Promise<boolean> => {
  const shortMint = mint.slice(0, 8) + '...';
  logger.info(`[🔍 DUPLICATE-CHECK] ${shortMint} | Checking for duplicate tokens`);
  
  try {
    // First, try fetching token data from pump.fun API
    let tokenName, tokenSymbol, tokenImage;
    
    try {
      logger.info(`[🔍 DUPLICATE-CHECK] ${shortMint} | Fetching from pump.fun API`);
      const response = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
      if (!response.ok) {
        throw new Error(`API responded with status: ${response.status}`);
      }
      
      const data = await response.json();
      tokenName = data.name;
      tokenSymbol = data.symbol;
      tokenImage = data.image;
      
      if (tokenName && tokenSymbol) {
        logger.info(`[🔍 DUPLICATE-CHECK] ${shortMint} | API data: Name=${tokenName}, Symbol=${tokenSymbol}`);
      } else {
        logger.warn(`[⚠️ API-WARNING] ${shortMint} | Incomplete data from API`);
      }
    } catch (apiError) {
      logger.warn(`[⚠️ API-ERROR] ${shortMint} | Failed to fetch from API: ${apiError instanceof Error ? apiError.message : String(apiError)}`);
    }

    // If API data is incomplete, try fetching from Metaplex
    if (!tokenSymbol) {
      try {
        logger.info(`[🔍 DUPLICATE-CHECK] ${shortMint} | Falling back to Metaplex`);
        const metaPlexData = await metaplex
          .nfts()
          .findByMint({ mintAddress: new PublicKey(mint) });
        
        tokenName = metaPlexData.name;
        tokenSymbol = metaPlexData.symbol;
        tokenImage = metaPlexData.json?.image;
        
        if (tokenName && tokenSymbol) {
          logger.info(`[🔍 DUPLICATE-CHECK] ${shortMint} | Metaplex data: Name=${tokenName}, Symbol=${tokenSymbol}`);
        } else {
          logger.warn(`[⚠️ METAPLEX-WARNING] ${shortMint} | Incomplete data from Metaplex`);
        }
      } catch (metaplexError) {
        logger.error(`[❌ METAPLEX-ERROR] ${shortMint} | Metaplex fetch failed: ${metaplexError instanceof Error ? metaplexError.message : String(metaplexError)}`);
        // If we can't get a symbol, we'll return true to skip this token
        return true;
      }
    }

    // If we still don't have token info, we can't check for duplicates
    if (!tokenSymbol) {
      logger.error(`[❌ TOKEN-ERROR] ${shortMint} | Failed to retrieve token information`);
      return true;
    }

    // Check for duplicates in the database
    try {
      const duplicateToken = await DBTokenList.findOne({
        tokenSymbol: tokenSymbol,
      });
      
      if (duplicateToken) {
        const daysSinceLastSeen = (Date.now() - duplicateToken.saveTime) / (1000 * 60 * 60 * 24);
        
        logger.info(`[🔍 DUPLICATE-CHECK] ${shortMint} | Found existing token: ${duplicateToken.mint.slice(0, 8)}..., Age: ${daysSinceLastSeen.toFixed(1)} days`);
        
        // Update timestamp if token is older than 5 days
        const expired = daysSinceLastSeen > 5;
        if (expired) {
          logger.info(`[🔄 TOKEN-UPDATE] ${shortMint} | Updating timestamp for expired token`);
          await DBTokenList.findOneAndUpdate(
            { mint: duplicateToken.mint },
            { saveTime: Date.now() }
          );
        }
        return true;
      } else {
        // Token is new, save it to database
        logger.info(`[✅ NEW-TOKEN] ${shortMint} | No duplicate found, saving to database`);
        
        const tokenData: Partial<IToken> = {
          mint,
          tokenName,
          tokenSymbol,
          tokenImage,
          saveTime: Date.now(),
        };

        const newToken = new DBTokenList(tokenData);
        await newToken.save();
        logger.info(`[💾 DB-SAVE] ${shortMint} | New token saved: ${tokenSymbol}`);
        return false;
      }
    } catch (dbError) {
      logger.error(`[❌ DB-ERROR] ${shortMint} | Database operation failed: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
      // If database check fails, we'll return true to be cautious
      return true;
    }
  } catch (error) {
    logger.error(`[❌ DUPLICATE-ERROR] ${shortMint} | Duplicate check failed: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
};

/**
 * Prepare monitoring data for direct handoff
 * This creates monitoring data without requiring a database lookup
 */
const prepareBuyMonitoringData = (
  mint: string,
  outAmount: number,
  price_usd: number
): { 
  buyTxInfo: Partial<ITransaction>,
  created_timestamp: number
} => {
  return {
    buyTxInfo: {
      mint: mint,
      txTime: Date.now(),
      swap: "BUY",
      swapPrice_usd: price_usd,
      swapAmount: outAmount,
      swapMC_usd: price_usd * TOTAL_SUPPLY,
    },
    created_timestamp: Date.now()
  };
};

/**
 * Fetches transaction details with timeout
 * @param signature The transaction signature
 * @returns Transaction data or null if timeout/error
 */
const fetchTransactionWithTimeout = async (signature: string) => {
  return await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  })
};

/**
 * Monitor a token for possible buying opportunity
 * Enhanced with detailed logging and improved error handling
 */
const monitorToken = async (
  mint: string,
  pumpTokenData: PumpData,
  user: PublicKey,
  created_timestamp: number
) => {
  const shortMint = mint.slice(0, 8) + '...';
  logger.info(`[🔍 MONITOR-TOKEN] ${shortMint} | Starting buy monitoring`);
  
  // Add to global buying map
  tokenBuyingMap.set(mint, Date.now());
  
  const run = async () => {
    try {
      const botBuyConfig = SniperBotConfig.getBuyConfig();

      // Check token age
      const _age = (Date.now() - created_timestamp) / 1000;
      let start_T = 0;
      let end_T = 30 * 60; // Default 30 minutes
      
      if (botBuyConfig.age.enabled) {
        start_T = botBuyConfig.age.start;
        end_T = botBuyConfig.age.end;
      }
      
      logger.info(`[🕒 AGE-CHECK] ${shortMint} | Token age: ${_age.toFixed(1)}s (Range: ${start_T}s-${end_T}s)`);
      
      // Check if token is too young
      if (_age < start_T) {
        logger.info(`[⏳ TOO-YOUNG] ${shortMint} | Token too young (${_age.toFixed(1)}s < ${start_T}s), waiting...`);
        setTimeout(run, BUY_MONITOR_CYCLE);
        return;
      }
      
      // Check if token is too old
      if (_age > end_T) {
        logger.info(
          `[⌛ TOO-OLD] ${shortMint} | Token too old (${_age.toFixed(1)}s > ${end_T}s), stopping monitor`
        );
        removeTokenBuyingMap(mint);
        return;
      }

      // Check if bot is running and within working hours
      if (!isRunning() || !isWorkingTime()) {
        logger.info(`[🛑 NOT-RUNNING] ${shortMint} | Bot not running or outside working hours. isRunning=${isRunning()}, isWorkingTime=${isWorkingTime()}`);
        setTimeout(run, BUY_MONITOR_CYCLE);
        return;
      }

      // Validate token
      let isValid: boolean = true;
      let pumpData: PumpData = pumpTokenData;
      
      // Only perform validation if end time is significant
      if (end_T > 10) {
        logger.info(`[🔍 VALIDATION] ${shortMint} | Performing token validation`);
        const result = await validateToken(mint, user);
        isValid = result.isValid;
        pumpData = result.pumpData;
        
        logger.info(`[🔍 VALIDATION] ${shortMint} | Validation result: ${isValid ? '✅ Valid' : '❌ Invalid'}`);
      }

      // If token is valid, proceed to buying
      if (isValid && pumpData) {
        logger.info(
          chalk.green(`[💰 BUY-DECISION] ${shortMint} | Token is valid. Proceeding with purchase...`)
        );

        // Prepare swap parameters
        const buyConfig = SniperBotConfig.getBuyConfig();
        const tip_sol = buyConfig.jitoTipAmount || 0.00001;
        
        logger.info(`[🔄 SWAP-PREP] ${shortMint} | Preparing swap with investment: ${buyConfig.investmentPerToken} SOL, tip: ${tip_sol} SOL`);
        
        // Validate that pumpData has all required fields
        if (!pumpData.bondingCurve || !pumpData.associatedBondingCurve || 
            !pumpData.virtualSolReserves || !pumpData.virtualTokenReserves) {
          logger.error(`[❌ PUMP-DATA-ERROR] ${shortMint} | Incomplete pump data, cannot proceed with swap`);
          setTimeout(run, BUY_MONITOR_CYCLE);
          return;
        }
        
        const swapParam: SwapParam = {
          mint: mint,
          amount: buyConfig.investmentPerToken,
          tip: tip_sol,
          slippage: buyConfig.slippage,
          is_buy: true,
          isPumpfun: true,
          pumpData: {
            price: Number(pumpData?.price),
            bondingCurve: pumpData?.bondingCurve,
            associatedBondingCurve: pumpData?.associatedBondingCurve,
            virtualSolReserves: pumpData?.virtualSolReserves,
            virtualTokenReserves: pumpData?.virtualTokenReserves,
          },
        };

        // Check wallet balance
        const walletBalance = getWalletBalanceFromCache();
        logger.info(`[💰 BALANCE-CHECK] ${shortMint} | Wallet balance: ${walletBalance.toFixed(4)} SOL`);
        
        if (walletBalance < 0.03) {
          logger.error(
            `[❌ LOW-BALANCE] ${shortMint} | Wallet balance ${walletBalance.toFixed(4)} SOL is too low (min: 0.03 SOL)`
          );
          
          // Create alert for low balance
          const newAlert: IAlertMsg = {
            imageUrl: PUMPFUN_IMG,
            title: "Insufficient Wallet Balance",
            content: `🚨 Your wallet needs more SOL to continue trading! 
            Current balance: ${walletBalance.toFixed(4)} SOL. 
            Bot operations paused for safety. Please top up your wallet to resume.`,
            link: wallet.publicKey.toBase58(),
            time: Date.now(),
            isRead: false,
          };
          
          await createAlert(newAlert);
          logger.info(`[🔔 ALERT] ${shortMint} | Created low balance alert`);
          
          // Turn off the bot
          const botMainconfig = SniperBotConfig.getMainConfig();
          await SniperBotConfig.setMainConfig({
            ...botMainconfig,
            isRunning: false,
          });
          
          logger.info(`[🛑 SHUTDOWN] ${shortMint} | Bot stopped due to low balance`);
          removeTokenBuyingMap(mint);
          return;
        }

        // Execute swap
        logger.info(`[🔄 SWAP-EXECUTE] ${shortMint} | Executing swap...`);
        const swapResult = await swap(swapParam);
        
        if (swapResult) {
          const { txHash, price, inAmount, outAmount } = swapResult;
          logger.info(`[✅ SWAP-SUCCESS] ${shortMint} | Transaction successful: ${txHash?.slice(0, 8)}...`);
          logger.info(`[📊 SWAP-DETAILS] ${shortMint} | Price: $${price?.toFixed(6)}, In: ${inAmount?.toFixed(6)} SOL, Out: ${outAmount?.toFixed(6)} tokens`);
          
          // Get SOL price for fee calculation
          const solPrice = getCachedSolPrice();
          
          // Prepare transaction data
          const save_data: ITxntmpData = {
            isAlert: false,
            txHash: txHash || "",
            mint: mint,
            swap: "BUY",
            swapPrice_usd: price,
            swapAmount: outAmount,
            swapFee_usd: tip_sol * solPrice,
            swapProfit_usd: 0,
            swapProfitPercent_usd: 0,
            dex: "Pumpfun",
          };
          
          // Prepare monitoring data before saving to database
          const monitoringData = prepareBuyMonitoringData(mint, outAmount, price);
          
          // Save transaction to database (don't await)
          logger.info(`[💾 DB-SAVE] ${shortMint} | Saving transaction to database...`);
          saveTXonDB(save_data).catch(dbError => {
            logger.error(`[❌ DB-ERROR] ${shortMint} | Failed to save transaction: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
          });
          
          // IMMEDIATE HANDOFF TO MONITORING - Crucial part that ensures we start monitoring right away
          logger.info(`[🔄 HANDOFF] ${shortMint} | Initiating immediate sell monitoring`);
          
          try {
            if (USE_WSS) {
              // Start WebSocket monitoring for this token with buyTx data
              logger.info(`[🔌 WSS-MONITOR] ${shortMint} | Starting WebSocket monitoring with direct data handoff`);
              await WssMonitorService.startMonitoringWithData(mint, monitoringData.buyTxInfo);
              
              const monitorDelay = Date.now() - monitoringData.created_timestamp;
              logger.trackBuyToMonitorDelay(mint, monitoringData.created_timestamp, Date.now());
              logger.info(`[✅ MONITOR-INIT] ${shortMint} | WebSocket monitoring started in ${monitorDelay}ms`);
            } else {
              // Start interval-based monitoring for this token with buyTx data
              logger.info(`[⏱️ INTERVAL-MONITOR] ${shortMint} | Starting interval monitoring with direct data handoff`);
              await tokenMonitorThread2Sell(mint, monitoringData.buyTxInfo);
              
              const monitorDelay = Date.now() - monitoringData.created_timestamp;
              logger.trackBuyToMonitorDelay(mint, monitoringData.created_timestamp, Date.now());
              logger.info(`[✅ MONITOR-INIT] ${shortMint} | Interval monitoring started in ${monitorDelay}ms`);
            }
          } catch (monitorError) {
            logger.error(`[❌ MONITOR-ERROR] ${shortMint} | Failed to initialize monitoring: ${monitorError instanceof Error ? monitorError.message : String(monitorError)}`);
          }
          
          // Remove from buying map
          removeTokenBuyingMap(mint);
          return;
        } else {
          logger.error(`[❌ SWAP-FAILED] ${shortMint} | Swap operation failed`);
        }
      } else {
        logger.info(`[❌ INVALID] ${shortMint} | Token not valid for buying, will retry`);
      }
      
      // Schedule next check
      setTimeout(run, BUY_MONITOR_CYCLE);
    } catch (error) {
      logger.error(`[❌ MONITOR-ERROR] ${shortMint} | Error monitoring token: ${error instanceof Error ? error.message : String(error)}`);
      setTimeout(run, BUY_MONITOR_CYCLE);
    }
  };
  
  // Start monitoring loop
  run();
};

/**
 * Checks if a signature has already been processed
 * @param signature Transaction signature
 * @returns True if this signature has been seen before
 */
function isSignatureProcessed(signature: string): boolean {
  if (processedSignatures.has(signature)) {
    return true;
  }
  
  // Add to processed signatures set
  processedSignatures.add(signature);
  
  // Limit size of processed signatures set
  if (processedSignatures.size > 1000) {
    // Convert to array, remove oldest entries, convert back to set
    const signatureArray = Array.from(processedSignatures);
    processedSignatures.clear();
    signatureArray.slice(signatureArray.length - 500).forEach(sig => processedSignatures.add(sig));
  }
  
  return false;
}

/**
 * Helper function to type cast transaction data
 */
interface ParsedTransaction {
  transaction?: {
    message?: {
      instructions?: any[];
    };
  };
  blockTime?: number;
  meta?: any;
}

/**
 * Main sniper service function
 * Listens for new token creations and initiates monitoring
 */
export async function sniperService() {
  logger.info(`${START_TXT.sniper} | Solana Pumpfun Sniper Bot started at ${new Date().toISOString()}`);
  logger.info(`[⚙️ CONFIG] Buy monitoring cycle: ${BUY_MONITOR_CYCLE/1000}s | Mode: ${USE_WSS ? 'WebSocket' : 'Interval'}-based monitoring`);
  
  try {
    // Set up log listener for the Pump.fun program
    connection.onLogs(
      PUMP_WALLET,
      async ({ logs, err, signature }) => {
        try {
          // Rate limiting to prevent processing overload
          const now = Date.now();
          if (now - lastLogProcessTime < MIN_LOG_PROCESS_INTERVAL) {
            return; // Skip this log if we're processing too frequently
          }
          lastLogProcessTime = now;
          
          // Handle transaction errors more gracefully
          if (err) {
            // Don't log common errors that aren't relevant to token creation
            const errorString = JSON.stringify(err);
            const isCommonError = errorString.includes("IllegalOwner") || 
                                  errorString.includes("Custom:6023") ||
                                  errorString.includes("Custom:6005");
            
            if (!isCommonError) {
              logger.error(`[❌ LOGS-ERROR] ${signature} | ${formatSolanaError(err)}`);
            }
            //return;
          }
          
          // Check if we've already processed this signature
          if (isSignatureProcessed(signature)) {
            return;
          }

          // Look for token creation events
          if (
            logs &&
            logs.some((log) =>
              log.includes("Program log: Instruction: InitializeMint2")
            )
          ) {
            logger.info(`[🔍 NEW-TOKEN] Detected new token creation: ${signature.slice(0, 8)}...`);
            
            // Get transaction details with timeout protection
            const txn = await fetchTransactionWithTimeout(signature) as ParsedTransaction;

            if (!txn) {
              logger.error(`[❌ TX-ERROR] Failed to get transaction details for ${signature.slice(0, 8)}...`);
              return;
            }

            try {
              // Extract account information
              const instructions = txn.transaction?.message?.instructions || [];
              const pumpInstruction = instructions.find(
                (ix: any) => ix.programId && ix.programId.toString() === PUMP_WALLET.toBase58()
              );
              
              if (!pumpInstruction || !pumpInstruction.accounts) {
                logger.error(`[❌ INSTRUCTION-ERROR] No valid PUMP instruction found for ${signature.slice(0, 8)}...`);
                return;
              }
              
              const accountKeys = pumpInstruction.accounts as PublicKey[];

              if (!accountKeys || accountKeys.length < 8) {
                logger.error(`[❌ KEY-ERROR] Invalid account keys for ${signature.slice(0, 8)}... (length: ${accountKeys?.length || 0})`);
                return;
              }

              // Extract relevant data
              const mint = accountKeys[0];
              const user = accountKeys[7]; // dev address
              const bondingCurve = accountKeys[2];
              const associatedBondingCurve = accountKeys[3];
              const shortMint = mint.toBase58().slice(0, 8) + '...';
              
              logger.info(`[🔍 TOKEN-INFO] ${shortMint} | Mint: ${mint.toBase58()}, Dev: ${user.toBase58().slice(0, 8)}...`);
              
              // Initialize with default values
              let virtualSolReserves = 30 * LAMPORTS_PER_SOL;
              let virtualTokenReserves = 1000000000 * 10 ** 6;
              
              if (txn.blockTime !== undefined && txn.meta) {
                  try {
                    // Verify account indices exist in the transaction metadata
                    if (!txn.meta.preBalances || !txn.meta.postBalances || 
                        txn.meta.preBalances.length === 0 || txn.meta.postBalances.length === 0) {
                      logger.error(`[❌ TX-DATA-ERROR] ${shortMint} | Transaction metadata missing balance information`);
                      return;
                    }
                    
                    const solSpent =
                      Math.abs(txn.meta.postBalances[0] - txn.meta.preBalances[0]) /
                      LAMPORTS_PER_SOL;
                      
                    logger.info(`[💰 DEV-SPEND] ${shortMint} | Developer spent: ${solSpent.toFixed(6)} SOL`);
                    
                    // Check if dev spent too much
                    const maxDevBuyAmount = SniperBotConfig.getMaxDevBuyAmount();
                    if (
                      maxDevBuyAmount.enabled &&
                      solSpent > maxDevBuyAmount.value
                    ) {
                      logger.info(`[❌ DEV-SPEND-HIGH] ${shortMint} | Developer spent too much: ${solSpent.toFixed(6)} SOL > limit ${maxDevBuyAmount.value} SOL`);
                      return;
                    }

                    // Calculate initial price and liquidity
                    const cachedSolPrice = getCachedSolPrice();
                    if (!cachedSolPrice || cachedSolPrice === 0) {
                      logger.error(`[❌ PRICE-ERROR] ${shortMint} | Invalid SOL price: ${cachedSolPrice}`);
                      return;
                    }
                    
                    const price = cachedSolPrice * (virtualSolReserves / LAMPORTS_PER_SOL) / (virtualTokenReserves / 10 ** 6);
                    
                    // Adjust virtual reserves based on developer spend
                    virtualTokenReserves -= solSpent * 10 ** 6 / price;
                    virtualSolReserves += solSpent * LAMPORTS_PER_SOL;
                    
                    logger.info(`[💰 INITIAL-PRICE] ${shortMint} | Initial price: $${price.toFixed(6)}, SOL Price: $${cachedSolPrice.toFixed(2)}`);

                    // Create pumpData object for monitoring
                    const pumpData: PumpData = {
                      bondingCurve,
                      associatedBondingCurve,
                      virtualSolReserves,
                      virtualTokenReserves,
                      price,
                      progress: 0,
                      totalSupply: 1000000000,
                      marketCap: price * 1000000000
                    };
                    
                    // Check for duplicates
                    let isDuplicated = false;
                    logger.info(`[🔍 DUPLICATE-CHECK] ${shortMint} | Checking for duplicate tokens (enabled: ${SniperBotConfig.getBuyConfig().duplicates.enabled})`);
                    
                    try {
                      if (SniperBotConfig.getBuyConfig().duplicates.enabled === true) {
                        isDuplicated = await checkDuplicates(mint.toBase58());
                      } else {
                        // Still add to database, but don't filter
                        checkDuplicates(mint.toBase58()).catch(err => {
                          logger.error(`[❌ DB-ERROR] ${shortMint} | Error saving token to database: ${err.message}`);
                        });
                      }
                    } catch (dupError) {
                      logger.error(`[❌ DUPLICATE-ERROR] ${shortMint} | Error checking for duplicates: ${dupError instanceof Error ? dupError.message : String(dupError)}`);
                      // Continue processing even if duplicate check fails
                    }
                    
                    if (isDuplicated) {
                      logger.info(`[❌ DUPLICATE] ${shortMint} | Duplicate token found, skipping`);
                      return;
                    }
                    
                    // Check if bot is running
                    if (!isRunning() || !isWorkingTime()) {
                      logger.info(`[🛑 NOT-RUNNING] ${shortMint} | Bot not running or outside working hours. isRunning=${isRunning()}, isWorkingTime=${isWorkingTime()}`);
                      return;
                    }
                    
                    const created_timestamp = txn.blockTime * 1000;
                    logger.info(`[🎯 NEW-TOKEN] ${shortMint} | Starting monitoring process | Created: ${new Date(created_timestamp).toISOString()}`);
                    
                    // Update buy monitor cycle from config
                    BUY_MONITOR_CYCLE = SniperBotConfig.getBuyIntervalTime();
                    
                    // Start monitoring the token
                    if (tokenBuyingMap.has(mint.toBase58())) {
                      logger.info(`[⚠️ ALREADY-MONITORING] ${shortMint} | Token is already being monitored, skipping`);
                    } else {
                      monitorToken(mint.toBase58(), pumpData, user, created_timestamp);
                    }
                  } catch (dataError) {
                    logger.error(`[❌ DATA-PROCESSING-ERROR] ${shortMint} | Error processing transaction data: ${dataError instanceof Error ? dataError.message : String(dataError)}`);
                  }
              } else {
                  logger.error(`[❌ TX-DATA-ERROR] ${shortMint} | Missing transaction data: blockTime or meta`);
              }
            } catch (instructionError) {
              logger.error(`[❌ INSTRUCTION-ERROR] Error extracting instruction data for ${signature.slice(0, 8)}...: ${instructionError instanceof Error ? instructionError.message : String(instructionError)}`);
            }
          }
        } catch (e: any) {
          logger.error(`[❌ LOGS-HANDLER-ERROR] Error processing logs for ${signature?.slice(0, 8) || 'unknown'}...: ${e.message}`);
          if (e.stack) {
            logger.error(`[❌ STACK-TRACE] ${e.stack.split('\n').slice(0, 3).join(' | ')}`);
          }
        }
      },
      COMMITMENT_LEVEL
    );
    
    logger.info(`[🔌 CONNECTED] Sniper service successfully connected to Solana network`);
    
    // Periodically clean up processed signatures to prevent memory leaks
    setInterval(() => {
      if (processedSignatures.size > 1000) {
        logger.info(`[🧹 CLEANUP] Cleaning up processed signatures (count: ${processedSignatures.size})`);
        const signatureArray = Array.from(processedSignatures);
        processedSignatures.clear();
        signatureArray.slice(signatureArray.length - 500).forEach(sig => processedSignatures.add(sig));
        logger.info(`[🧹 CLEANUP] Reduced processed signatures to ${processedSignatures.size}`);
      }
    }, 30 * 60 * 1000); // Clean up every 30 minutes
    
  } catch (e: any) {
    logger.error(`[❌ CONNECTION-ERROR] Failed to connect sniper service: ${e.message}`);
    if (e.stack) {
      logger.error(`[❌ STACK-TRACE] ${e.stack.split('\n').slice(0, 3).join(' | ')}`);
    }
    
    // Try to reconnect after a delay
    setTimeout(() => {
      logger.info(`[🔄 RECONNECT] Attempting to reconnect sniper service...`);
      sniperService().catch(err => {
        logger.error(`[❌ RECONNECT-FAILED] Failed to reconnect: ${err.message}`);
      });
    }, 60 * 1000); // Wait 1 minute before reconnecting
  }
}