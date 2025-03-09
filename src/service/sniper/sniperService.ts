import { Commitment, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connection, metaplex, START_TXT, wallet } from "../../config";
import { SniperBotConfig } from "../setting/botConfigClass";
import { getPumpData, getTokenBalance } from "../pumpfun/pumpfun";
import { PUMPFUN_IMG, TOKEN_DECIMALS, TOTAL_SUPPLY } from "../../utils/constants";
import { swap } from "../swap/swap"; // Use your optimized swap
import { saveTXonDB } from "../tx/TxService";
import { getCachedSolPrice } from "./getBlock";
import logger from "../../logs/logger";
import { SwapParam, ITxntmpData, IAlertMsg, PumpData } from "../../utils/types";
import { isRunning, isWorkingTime, getDexscreenerData } from "../../utils/utils";
import { DBTokenList } from "../../models/TokenList";
import { getWalletBalanceFromCache } from "./getWalletBalance";
import { createAlert } from "../alarm/alarm";
import { WssMonitorService } from "./wssMonitorService"; // Use your optimized monitoring service
import { ITransaction } from "../../models/SniperTxns";

// Constants
const PUMP_WALLET = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const COMMITMENT_LEVEL = "confirmed" as Commitment;
const MAX_LOG_BUFFER_SIZE = 200;
const LOG_BUFFER_PROCESS_INTERVAL = 100; // ms
const SIGNATURE_CLEANUP_INTERVAL = 15 * 60 * 1000; // 15 minutes
const MEMORY_MONITOR_INTERVAL = 5 * 60 * 1000; // 5 minutes
const HIGH_MEMORY_THRESHOLD_MB = 800;

// Data structures
const tokenBuyingMap: Map<string, number> = new Map();
const processedSignatures: Set<string> = new Set();
const logBuffer: Map<string, {
  logs: string[],
  signature: string,
  timestamp: number,
  processed: boolean
}> = new Map();

// Last processed times to rate limit processing
let lastLogProcessTime = 0;
let lastMemoryCheckTime = 0;

/**
 * Helper function to get token short name for logs
 */
function getTokenShortName(mint: string): string {
  return `${mint.slice(0, 8)}...`;
}

/**
 * Remove token from buying map
 */
export const removeTokenBuyingMap = (mint: string): void => {
  const shortMint = getTokenShortName(mint);
  logger.info(`[🔄 BUYING-MAP] Removing token ${shortMint} from buying map`);
  tokenBuyingMap.delete(mint);
};

/**
 * Format Solana error messages for better logging
 */
function formatSolanaError(error: any): string {
  try {
    if (typeof error === 'string') {
      return error;
    }

    if (typeof error === 'object') {
      if (error.InstructionError) {
        const [index, errorDetail] = error.InstructionError;
        
        if (typeof errorDetail === 'string') {
          return `Instruction ${index} failed: ${errorDetail}`;
        } else if (typeof errorDetail === 'object' && errorDetail.Custom !== undefined) {
          return `Instruction ${index} failed: Custom error ${errorDetail.Custom}`;
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
 * Check if signature has already been processed
 */
function isSignatureProcessed(signature: string): boolean {
  return processedSignatures.has(signature);
}

/**
 * Add signature to processed signatures set
 */
function markSignatureProcessed(signature: string): void {
  processedSignatures.add(signature);
}

/**
 * Clean up old signatures to prevent memory leaks
 */
function cleanupProcessedSignatures(): void {
  if (processedSignatures.size <= 1000) return;
  
  logger.info(`[🧹 CLEANUP] Cleaning up processed signatures (count: ${processedSignatures.size})`);
  const signatureArray = Array.from(processedSignatures);
  processedSignatures.clear();
  signatureArray.slice(signatureArray.length - 500).forEach(sig => processedSignatures.add(sig));
  logger.info(`[🧹 CLEANUP] Reduced processed signatures to ${processedSignatures.size}`);
}

/**
 * Create a low balance alert and turn off the bot
 */
async function createLowBalanceAlert(walletBalance: number): Promise<void> {
  try {
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
    logger.info(`[🔔 ALERT] Created low balance alert`);
    
    // Turn off the bot
    const botMainconfig = SniperBotConfig.getMainConfig();
    await SniperBotConfig.setMainConfig({
      ...botMainconfig,
      isRunning: false,
    });
    
    logger.info(`[🛑 SHUTDOWN] Bot stopped due to low balance`);
  } catch (error) {
    logger.error(`[❌ ALERT-ERROR] Error creating low balance alert: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetch transaction details with timeout
 */
async function fetchTransactionWithTimeout(signature: string): Promise<any> {
  try {
    return await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch (error) {
    logger.error(`[❌ TX-FETCH-ERROR] Error fetching transaction ${signature.slice(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Check if token is a duplicate
 */
async function checkDuplicates(mint: string): Promise<boolean> {
  const shortMint = getTokenShortName(mint);
  logger.info(`[🔍 DUPLICATE-CHECK] ${shortMint} | Checking for duplicate tokens`);
  
  try {
    // Get token symbol
    let tokenName = "", tokenSymbol = "", tokenImage = "";
    
    // Try fetching from pump.fun API first
    try {
      const response = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
      if (response.ok) {
        const data = await response.json();
        tokenName = data.name;
        tokenSymbol = data.symbol;
        tokenImage = data.image;
      }
    } catch (apiError) {
      logger.warn(`[⚠️ API-ERROR] ${shortMint} | Failed to fetch from API: ${apiError instanceof Error ? apiError.message : String(apiError)}`);
    }

    // If API failed, try Metaplex
    if (!tokenSymbol) {
      try {
        const metaPlexData = await metaplex
          .nfts()
          .findByMint({ mintAddress: new PublicKey(mint) });
        
        tokenName = metaPlexData.name;
        tokenSymbol = metaPlexData.symbol;
        tokenImage = metaPlexData.json?.image;
      } catch (metaplexError) {
        logger.error(`[❌ METAPLEX-ERROR] ${shortMint} | Metaplex fetch failed: ${metaplexError instanceof Error ? metaplexError.message : String(metaplexError)}`);
        return true; // Skip token if we can't get info
      }
    }

    if (!tokenSymbol) {
      logger.error(`[❌ TOKEN-ERROR] ${shortMint} | Failed to retrieve token information`);
      return true;
    }

    // Check DB for duplicates
    const duplicateToken = await DBTokenList.findOne({
      tokenSymbol: tokenSymbol,
    });
    
    if (duplicateToken) {
      const daysSinceLastSeen = (Date.now() - duplicateToken.saveTime) / (1000 * 60 * 60 * 24);
      
      logger.info(`[🔍 DUPLICATE-FOUND] ${shortMint} | Found existing token: ${duplicateToken.mint.slice(0, 8)}..., Age: ${daysSinceLastSeen.toFixed(1)} days`);
      
      // Update timestamp if token is older than 5 days
      if (daysSinceLastSeen > 5) {
        await DBTokenList.findOneAndUpdate(
          { mint: duplicateToken.mint },
          { saveTime: Date.now() }
        );
        logger.info(`[🔄 TOKEN-UPDATE] ${shortMint} | Updated timestamp for expired token`);
      }
      
      return SniperBotConfig.getBuyConfig().duplicates.enabled;
    } else {
      // Token is new, save it to database
      logger.info(`[✅ NEW-TOKEN] ${shortMint} | No duplicate found, saving to database`);
      
      try {
        await new DBTokenList({
          mint,
          tokenName,
          tokenSymbol,
          tokenImage,
          saveTime: Date.now(),
        }).save();
        
        logger.info(`[💾 DB-SAVE] ${shortMint} | New token saved: ${tokenSymbol}`);
      } catch (dbError) {
        logger.error(`[❌ DB-ERROR] ${shortMint} | Database operation failed: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
      }
      
      return false;
    }
  } catch (error) {
    logger.error(`[❌ DUPLICATE-ERROR] ${shortMint} | Duplicate check failed: ${error instanceof Error ? error.message : String(error)}`);
    return true; // Be cautious, skip token on error
  }
}

/**
 * Validate token based on configured criteria
 */
export const validateToken = async (mint: string, dev: PublicKey): Promise<{ isValid: boolean, pumpData: PumpData | null }> => {
  const shortMint = getTokenShortName(mint);
  logger.info(`[🔍 VALIDATE] ${shortMint} | Starting token validation`);
  const validationStart = Date.now();
  
  try {
    // Start validation in parallel for better performance
    const botBuyConfig = SniperBotConfig.getBuyConfig();
    
    // Gather all validation promises
    const validationPromises: Promise<any>[] = [];
    
    // Promise for pump data (always needed)
    const pumpDataPromise = getPumpData(new PublicKey(mint));
    validationPromises.push(pumpDataPromise);
    
    // Optional validation checks based on configuration
    if (botBuyConfig.maxDevHoldingAmount.enabled) {
      validationPromises.push(getTokenBalance(dev.toString(), mint));
    } else {
      validationPromises.push(Promise.resolve(0));
    }

    if (botBuyConfig.holders.enabled) {
      validationPromises.push(
        connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
          filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
        })
      );
    } else {
      validationPromises.push(Promise.resolve({ length: 0 }));
    }
    
    if (botBuyConfig.lastHourVolume.enabled || botBuyConfig.lastMinuteTxns.enabled) {
      validationPromises.push(getDexscreenerData(mint));
    } else {
      validationPromises.push(Promise.resolve(null));
    }

    // Wait for all validation checks to complete
    const [pumpData, devHolding, accountsResult, dexScreenerData] = await Promise.all(validationPromises);

    // If PumpData fetch failed, we can't proceed
    if (!pumpData) {
      logger.error(`[❌ VALIDATE-ERROR] ${shortMint} | Failed to fetch pump data`);
      return { isValid: false, pumpData: null };
    }

    // Market cap validation
    const _mc = Number(pumpData?.marketCap || 0);
    const _holders = accountsResult?.length || 0;
    let isValid = true;
    
    logger.info(`[🔍 VALIDATE] ${shortMint} | Market cap: $${_mc.toFixed(2)}, Holders: ${_holders}`);
    
    // Validate against criteria
    if (botBuyConfig.marketCap.enabled && 
        !(botBuyConfig.marketCap.min <= _mc && _mc <= botBuyConfig.marketCap.max)) {
      logger.info(`[❌ INVALID] ${shortMint} | Market cap outside range: $${_mc.toFixed(2)} (range: $${botBuyConfig.marketCap.min}-$${botBuyConfig.marketCap.max})`);
      isValid = false;
    }
    
    if (botBuyConfig.maxDevHoldingAmount.enabled && 
        Number(devHolding || 0) > (TOTAL_SUPPLY / 100) * botBuyConfig.maxDevHoldingAmount.value) {
      logger.info(`[❌ INVALID] ${shortMint} | Developer holding too high: ${Number(devHolding || 0)} tokens`);
      isValid = false;
    }
    
    if (botBuyConfig.holders.enabled && _holders < botBuyConfig.holders.value) {
      logger.info(`[❌ INVALID] ${shortMint} | Not enough holders: ${_holders} (min: ${botBuyConfig.holders.value})`);
      isValid = false;
    }

    // Validate DexScreener data if needed
    if (botBuyConfig.lastHourVolume.enabled || botBuyConfig.lastMinuteTxns.enabled) {
      if (!dexScreenerData || !dexScreenerData[0]) {
        if (botBuyConfig.lastHourVolume.enabled || botBuyConfig.lastMinuteTxns.enabled) {
          logger.info(`[❌ INVALID] ${shortMint} | No DexScreener data available`);
          isValid = false;
        }
      } else {
        const dexData = dexScreenerData[0];
        
        if (botBuyConfig.lastHourVolume.enabled && 
            (!dexData.volume || !dexData.volume.h1 || dexData.volume.h1 < botBuyConfig.lastHourVolume.value)) {
          logger.info(`[❌ INVALID] ${shortMint} | Hour volume too low: $${dexData.volume?.h1 || 0} (min: $${botBuyConfig.lastHourVolume.value})`);
          isValid = false;
        }
        
        if (botBuyConfig.lastMinuteTxns.enabled && dexData.txns && dexData.txns.h1) {
          const _txns = dexData.txns.h1.buys + dexData.txns.h1.sells || 0;
          if (_txns < botBuyConfig.lastMinuteTxns.value) {
            logger.info(`[❌ INVALID] ${shortMint} | Not enough transactions: ${_txns} (min: ${botBuyConfig.lastMinuteTxns.value})`);
            isValid = false;
          }
        }
      }
    }

    const validationTime = Date.now() - validationStart;
    logger.info(`[🔍 VALIDATE] ${shortMint} | Validation completed in ${validationTime}ms: ${isValid ? '✅ Valid' : '❌ Invalid'}`);
    return { isValid, pumpData };
  } catch (error) {
    const validationTime = Date.now() - validationStart;
    logger.error(`[❌ VALIDATE-ERROR] ${shortMint} | Token validation error after ${validationTime}ms: ${error instanceof Error ? error.message : String(error)}`);
    return { isValid: false, pumpData: null };
  }
};

/**
 * Prepare monitoring data for direct handoff to the monitoring service
 */
function prepareBuyMonitoringData(mint: string, outAmount: number, price_usd: number): Partial<ITransaction> {
  return {
    mint: mint,
    txTime: Date.now(),
    swap: "BUY",
    swapPrice_usd: price_usd,
    swapAmount: outAmount,
    swapMC_usd: price_usd * TOTAL_SUPPLY
  };
}

/**
 * Calculate expected token output based on pump data
 */
function calculateExpectedOutput(pumpData: PumpData, solAmount: number): number {
  try {
    if (!pumpData.virtualSolReserves || !pumpData.virtualTokenReserves) {
      return 0;
    }
    
    // Convert to lamports
    const solAmountLamports = solAmount * LAMPORTS_PER_SOL;
    
    // Calculate token output
    const expectedOutput = Math.floor(
      (solAmountLamports * pumpData.virtualTokenReserves) / pumpData.virtualSolReserves
    );
    
    // Convert to decimal
    return expectedOutput / 10 ** TOKEN_DECIMALS;
  } catch (error) {
    logger.error(`[❌ CALC-ERROR] Error calculating expected output: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

/**
 * Process transaction for a new token
 */
async function processTransaction(txn: any, signature: string): Promise<void> {
  if (!txn || !txn.transaction?.message?.instructions) {
    return;
  }

  try {
    // Extract account information
    const instructions = txn.transaction.message.instructions;
    const pumpInstruction = instructions.find(
      (ix: any) => ix.programId && ix.programId.toString() === PUMP_WALLET.toBase58()
    );
    
    if (!pumpInstruction || !pumpInstruction.accounts) {
      return;
    }
    
    const accountKeys = pumpInstruction.accounts as PublicKey[];
    if (!accountKeys || accountKeys.length < 8) {
      return;
    }

    // Extract token info
    const mint = accountKeys[0].toBase58();
    const user = accountKeys[7].toBase58(); // dev address
    const bondingCurve = accountKeys[2];
    const associatedBondingCurve = accountKeys[3];
    const shortMint = getTokenShortName(mint);
    
    logger.info(`[🔍 TOKEN-INFO] ${shortMint} | Mint: ${mint}, Dev: ${user.slice(0, 8)}...`);
    
    // Initialize token parameters
    let virtualSolReserves = 30 * LAMPORTS_PER_SOL;
    let virtualTokenReserves = 1000000000 * 10 ** TOKEN_DECIMALS;
    
    if (txn.blockTime !== undefined && txn.meta) {
      // Verify transaction metadata
      if (!txn.meta.preBalances || !txn.meta.postBalances || 
          txn.meta.preBalances.length === 0 || txn.meta.postBalances.length === 0) {
        logger.error(`[❌ TX-DATA-ERROR] ${shortMint} | Transaction metadata missing balance information`);
        return;
      }
      
      // Calculate SOL spent by developer
      const solSpent = Math.abs(txn.meta.postBalances[0] - txn.meta.preBalances[0]) / LAMPORTS_PER_SOL;
      logger.info(`[💰 DEV-SPEND] ${shortMint} | Developer spent: ${solSpent.toFixed(6)} SOL`);
      
      // Check if dev spent too much
      const maxDevBuyAmount = SniperBotConfig.getMaxDevBuyAmount();
      if (maxDevBuyAmount.enabled && solSpent > maxDevBuyAmount.value) {
        logger.info(`[❌ DEV-SPEND-HIGH] ${shortMint} | Developer spent too much: ${solSpent.toFixed(6)} SOL > limit ${maxDevBuyAmount.value} SOL`);
        return;
      }

      // Calculate initial price and liquidity
      const cachedSolPrice = getCachedSolPrice();
      if (!cachedSolPrice || cachedSolPrice === 0) {
        logger.error(`[❌ PRICE-ERROR] ${shortMint} | Invalid SOL price: ${cachedSolPrice}`);
        return;
      }
      
      // Calculate token price
      const initialPrice = cachedSolPrice * (virtualSolReserves / LAMPORTS_PER_SOL) / (virtualTokenReserves / 10 ** TOKEN_DECIMALS);
      
      // Adjust virtual reserves based on developer spend
      const adjustedTokenReserves = virtualTokenReserves - (solSpent * 10 ** TOKEN_DECIMALS / initialPrice);
      const adjustedSolReserves = virtualSolReserves + (solSpent * LAMPORTS_PER_SOL);
      
      // Calculate market cap
      const marketCap = initialPrice * 1000000000;
      
      logger.info(`[💰 INITIAL-PRICE] ${shortMint} | Price: $${initialPrice.toFixed(6)}, MC: $${marketCap.toFixed(2)}, SOL Price: $${cachedSolPrice.toFixed(2)}`);

      // Create pumpData object for monitoring
      const pumpData: PumpData = {
        bondingCurve,
        associatedBondingCurve,
        virtualSolReserves: adjustedSolReserves,
        virtualTokenReserves: adjustedTokenReserves,
        price: initialPrice,
        progress: 0,
        totalSupply: 1000000000,
        marketCap
      };
      
      // Check for duplicates - but don't block the flow
      const duplicateCheckPromise = checkDuplicates(mint);
      duplicateCheckPromise.then(isDuplicated => {
        if (isDuplicated) {
          logger.info(`[❌ DUPLICATE] ${shortMint} | Duplicate token found, skipping`);
          return;
        }
        
        // Check if bot is running
        if (!isRunning() || !isWorkingTime()) {
          logger.info(`[🛑 NOT-RUNNING] ${shortMint} | Bot not running or outside working hours`);
          return;
        }
        
        // Start timestamp (milliseconds)
        const created_timestamp = txn.blockTime * 1000;
        logger.info(`[🎯 NEW-TOKEN] ${shortMint} | Starting monitoring process | Created: ${new Date(created_timestamp).toISOString()}`);
        
        // Start monitoring the token
        if (tokenBuyingMap.has(mint)) {
          logger.info(`[⚠️ ALREADY-MONITORING] ${shortMint} | Token is already being monitored`);
        } else {
          monitorToken(mint, pumpData, new PublicKey(user), created_timestamp);
        }
      }).catch(error => {
        logger.error(`[❌ DUPLICATE-ERROR] ${shortMint} | Error checking duplicates: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      logger.error(`[❌ TX-DATA-ERROR] ${shortMint} | Missing transaction data: blockTime or meta`);
    }
  } catch (error) {
    logger.error(`[❌ TX-PROCESSING-ERROR] Error processing transaction ${signature.slice(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Enhanced token monitoring with improved performance
 */
const monitorToken = async (
  mint: string,
  pumpTokenData: PumpData,
  user: PublicKey,
  created_timestamp: number
) => {
  const shortMint = getTokenShortName(mint);
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
        setTimeout(run, SniperBotConfig.getBuyIntervalTime());
        return;
      }
      
      // Check if token is too old
      if (_age > end_T) {
        logger.info(`[⌛ TOO-OLD] ${shortMint} | Token too old (${_age.toFixed(1)}s > ${end_T}s), stopping monitor`);
        removeTokenBuyingMap(mint);
        return;
      }

      // Check if bot is running and within working hours
      if (!isRunning() || !isWorkingTime()) {
        logger.info(`[🛑 NOT-RUNNING] ${shortMint} | Bot not running or outside working hours, waiting...`);
        setTimeout(run, SniperBotConfig.getBuyIntervalTime());
        return;
      }

      // Validate token
      let isValid: boolean = true;
      let pumpData: PumpData = pumpTokenData;
      
      // Only perform validation if end time is significant (skip for very fast tokens)
      if (end_T > 10) {
        logger.info(`[🔍 VALIDATION] ${shortMint} | Performing token validation`);
        const validationStart = Date.now();
        const result = await validateToken(mint, user);
        isValid = result.isValid;
        pumpData = result.pumpData || pumpTokenData;
        
        const validationTime = Date.now() - validationStart;
        logger.info(`[🔍 VALIDATION] ${shortMint} | Completed in ${validationTime}ms | Result: ${isValid ? '✅ Valid' : '❌ Invalid'}`);
      }

      // If token is valid, proceed to buying
      if (isValid && pumpData) {
        logger.info(`[💰 BUY-DECISION] ${shortMint} | Token is valid. Proceeding with purchase...`);

        // Prepare swap parameters
        const buyConfig = SniperBotConfig.getBuyConfig();
        const tip_sol = buyConfig.jitoTipAmount || 0.00001;
        
        logger.info(`[🔄 SWAP-PREP] ${shortMint} | Investment: ${buyConfig.investmentPerToken} SOL, tip: ${tip_sol} SOL`);
        
        // Validate pumpData
        if (!pumpData.bondingCurve || !pumpData.associatedBondingCurve || 
            !pumpData.virtualSolReserves || !pumpData.virtualTokenReserves) {
          logger.error(`[❌ PUMP-DATA-ERROR] ${shortMint} | Incomplete pump data, cannot proceed`);
          setTimeout(run, SniperBotConfig.getBuyIntervalTime());
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
          logger.error(`[❌ LOW-BALANCE] ${shortMint} | Wallet balance too low (${walletBalance.toFixed(4)} SOL), minimum 0.03 SOL required`);
          createLowBalanceAlert(walletBalance);
          removeTokenBuyingMap(mint);
          return;
        }

        // Calculate expected output for pre-monitoring
        const expectedOutAmount = calculateExpectedOutput(pumpData, buyConfig.investmentPerToken);
        
        // Start monitoring BEFORE transaction is confirmed
        const preMonitoringData = prepareBuyMonitoringData(mint, expectedOutAmount, pumpData.price);
        
        // Fire and forget pre-monitoring (don't await this)
        logger.info(`[🔄 PRE-MONITOR] ${shortMint} | Starting preliminary monitoring with expected values`);
        const preMonitorStartTime = Date.now();
        
        WssMonitorService.startMonitoringWithData(mint, preMonitoringData, true)
          .catch(err => logger.error(`[❌ PRE-MONITOR-ERROR] ${shortMint} | ${err.message}`));
        
        // Execute swap
        logger.info(`[🔄 SWAP-EXECUTE] ${shortMint} | Executing swap...`);
        const swapStartTime = Date.now();
        const swapResult = await swap(swapParam);
        const swapTime = Date.now() - swapStartTime;
        
        if (swapResult) {
          const { txHash, price, inAmount, outAmount } = swapResult;
          logger.info(`[✅ SWAP-SUCCESS] ${shortMint} | Transaction completed in ${swapTime}ms: ${txHash?.slice(0, 8)}...`);
          logger.info(`[📊 SWAP-DETAILS] ${shortMint} | Price: $${price?.toFixed(6)}, In: ${inAmount?.toFixed(6)} SOL, Out: ${outAmount?.toFixed(6)} tokens`);
          
          // Get SOL price for fee calculation
          const solPrice = getCachedSolPrice();
          
          // Prepare transaction data for database
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
          
          // Save transaction to database without blocking
          saveTXonDB(save_data).catch(dbError => {
            logger.error(`[❌ DB-ERROR] ${shortMint} | Failed to save transaction: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
          });
          
          // Update monitoring with actual values
          const finalMonitoringData = {
            mint: mint,
            txTime: Date.now(),
            swap: "BUY",
            swapPrice_usd: price,
            swapAmount: outAmount,
            swapMC_usd: price * TOTAL_SUPPLY,
          };
          
          // Update the already running monitoring with actual values
          logger.info(`[🔄 MONITOR-UPDATE] ${shortMint} | Updating monitoring with actual values`);
          WssMonitorService.updateMonitoringData(mint, finalMonitoringData);
          
          // Record performance metrics
          const buyToMonitorDelay = preMonitorStartTime - swapStartTime;
          logger.info(`[📊 PERFORMANCE] ${shortMint} | Buy-to-monitor delay: ${buyToMonitorDelay}ms | Swap time: ${swapTime}ms`);
          
          // Remove from buying map
          removeTokenBuyingMap(mint);
          return;
        } else {
          logger.error(`[❌ SWAP-FAILED] ${shortMint} | Swap operation failed`);
          
          // Cancel preliminary monitoring
          WssMonitorService.stopMonitoring(mint);
        }
      } else {
        logger.info(`[❌ INVALID] ${shortMint} | Token not valid for buying, will retry`);
      }
      
      // Schedule next check
      setTimeout(run, SniperBotConfig.getBuyIntervalTime());
    } catch (error) {
      logger.error(`[❌ MONITOR-ERROR] ${shortMint} | Error monitoring token: ${error instanceof Error ? error.message : String(error)}`);
      setTimeout(run, SniperBotConfig.getBuyIntervalTime());
    }
  };
  
  // Start monitoring loop
  run();
};

/**
 * Process log buffer to reduce overhead
 */
function processLogBuffer(): void {
  const now = Date.now();
  
  // Skip if rate limited
  if (now - lastLogProcessTime < LOG_BUFFER_PROCESS_INTERVAL) {
    return;
  }
  
  lastLogProcessTime = now;
  
  try {
    // Get unprocessed logs
    const unprocessedLogs = Array.from(logBuffer.entries())
      .filter(([_, data]) => !data.processed)
      .slice(0, 10); // Process in small batches
    
    if (unprocessedLogs.length === 0) {
      return;
    }
    
    unprocessedLogs.forEach(async ([signature, data]) => {
      // Mark as processed
      data.processed = true;
      
      try {
        // Skip if already processed (double check)
        if (isSignatureProcessed(signature)) {
          return;
        }
        
        markSignatureProcessed(signature);
        
        // Look for token creation events
        if (!data.logs.some(log => log.includes("Program log: Instruction: InitializeMint2"))) {
          return;
        }
        
        logger.info(`[🔍 NEW-TOKEN] Detected new token creation: ${signature.slice(0, 8)}...`);
        
        // Get transaction details
        const txn = await fetchTransactionWithTimeout(signature);
        if (!txn) {
          return;
        }
        
        // Process the transaction
        await processTransaction(txn, signature);
      } catch (error) {
        logger.error(`[❌ LOG-PROCESSING-ERROR] Error processing logs for ${signature.slice(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  } catch (error) {
    logger.error(`[❌ BUFFER-ERROR] Error processing log buffer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check memory usage and perform cleanup if needed
 */
function checkMemoryUsage(): void {
  const now = Date.now();
  
  // Skip if checked recently
  if (now - lastMemoryCheckTime < 60000) {
    return;
  }
  
  lastMemoryCheckTime = now;
  
  try {
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    
    logger.info(`[🧠 MEMORY] Heap used: ${heapUsedMB}MB | RSS: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB`);
    
    if (heapUsedMB > HIGH_MEMORY_THRESHOLD_MB) {
      logger.warn(`[⚠️ HIGH-MEMORY] High memory usage detected (${heapUsedMB}MB), forcing cleanup`);
      
      // Clean up log buffer
      const oldLogs = Array.from(logBuffer.entries())
        .filter(([_, data]) => now - data.timestamp > 60000);
      
      oldLogs.forEach(([key]) => logBuffer.delete(key));
      
      // Force cleanup of processed signatures
      cleanupProcessedSignatures();
      
      // Optionally, clean up older token monitoring
      if (heapUsedMB > HIGH_MEMORY_THRESHOLD_MB + 200) {
        logger.warn(`[⚠️ CRITICAL-MEMORY] Critical memory usage (${heapUsedMB}MB), cleaning up token monitoring`);
        
        // // Clean up oldest token monitors (implementation depends on your monitoring system)
        // const tokenEntries = Array.from(tokenCreatedTime.entries())
        //   .sort((a, b) => a[1] - b[1]);
        
        // // Take the oldest 5 tokens
        // const tokensToRemove = tokenEntries.slice(0, 5).map(entry => entry[0]);
        // for (const tokenMint of tokensToRemove) {
        //   WssMonitorService.stopMonitoring(tokenMint);
        // }
      }
    }
  } catch (error) {
    logger.error(`[❌ MEMORY-ERROR] Error checking memory usage: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Main sniper service function
 */
export async function optimizedSniperService() {
  logger.info(`${START_TXT.sniper} | Optimized Solana Pumpfun Sniper Bot started at ${new Date().toISOString()}`);
  
  try {
    // Initialize the OptimizedWssMonitorService if not already initialized
    if (!WssMonitorService.isInitialized) {
      WssMonitorService.initialize();
    }
    
    // Set up log listener with buffering
    connection.onLogs(
      PUMP_WALLET,
      async ({ logs, err, signature }) => {
        try {
          // Skip if signature already processed
          if (isSignatureProcessed(signature)) {
            return;
          }
          
          // Skip logs with errors (optional)
          if (err) {
            const errorString = JSON.stringify(err);
            const isCommonError = errorString.includes("IllegalOwner") || 
                                 errorString.includes("Custom:6023") ||
                                 errorString.includes("Custom:6005");
            
            if (!isCommonError) {
              logger.error(`[❌ LOGS-ERROR] ${signature.slice(0, 8)}... | ${formatSolanaError(err)}`);
            }
            return;
          }
          
          // Add to buffer instead of processing immediately
          logBuffer.set(signature, {
            logs,
            signature,
            timestamp: Date.now(),
            processed: false
          });
          
          // Clean up old entries if buffer is too large
          if (logBuffer.size > MAX_LOG_BUFFER_SIZE) {
            // Sort by timestamp, oldest first
            const oldestLogs = Array.from(logBuffer.entries())
              .sort((a, b) => a[1].timestamp - b[1].timestamp)
              .slice(0, MAX_LOG_BUFFER_SIZE / 2);
            
            // Remove oldest half
            oldestLogs.forEach(([key]) => logBuffer.delete(key));
          }
        } catch (e) {
          logger.error(`[❌ LOG-HANDLER-ERROR] Error handling logs for ${signature?.slice(0, 8) || 'unknown'}: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      COMMITMENT_LEVEL
    );
    
    logger.info(`[🔌 CONNECTED] Optimized Sniper service successfully connected to Solana network`);
    
    // Set up periodic processing of log buffer
    setInterval(processLogBuffer, LOG_BUFFER_PROCESS_INTERVAL);
    
    // Set up periodic signature cleanup
    setInterval(cleanupProcessedSignatures, SIGNATURE_CLEANUP_INTERVAL);
    
    // Set up memory monitoring
    setInterval(checkMemoryUsage, MEMORY_MONITOR_INTERVAL);
  } catch (e) {
    logger.error(`[❌ CONNECTION-ERROR] Failed to connect sniper service: ${e instanceof Error ? e.message : String(e)}`);
    
    // Try to reconnect after a delay
    setTimeout(() => {
      logger.info(`[🔄 RECONNECT] Attempting to reconnect sniper service...`);
      optimizedSniperService().catch(err => {
        logger.error(`[❌ RECONNECT-FAILED] Failed to reconnect: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 60 * 1000); // Wait 1 minute before reconnecting
  }
}