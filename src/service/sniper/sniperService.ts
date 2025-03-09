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
const PUMP_WALLET = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const COMMITMENT_LEVEL = "confirmed" as Commitment;
let BUY_MONITOR_CYCLE = SniperBotConfig.getBuyIntervalTime();

// Track tokens being monitored
const tokenBuyingMap: Map<string, number> = new Map();
export const removeTokenBuyingMap = (value: string) => {
  logger.info(`[🔄 BUYING-MAP] Removing token ${value.slice(0, 8)}... from buying map`);
  tokenBuyingMap.delete(value);
};

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
    const promiseResult = await Promise.all(promiseArray);
    const validationTime = Date.now() - validationStart;
    
    const pumpData = promiseResult[pumpid];
    const _devHolding = promiseResult[devHoldingId];
    const allAccounts = promiseResult[allAccountsId];
    const dexData = promiseResult[dexScreenerId];

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
      const tmpdata = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
      const data = await tmpdata.json();
      tokenName = data.name;
      tokenSymbol = data.symbol;
      tokenImage = data.image;
      
      logger.info(`[🔍 DUPLICATE-CHECK] ${shortMint} | API data: Name=${tokenName}, Symbol=${tokenSymbol}`);
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
        
        logger.info(`[🔍 DUPLICATE-CHECK] ${shortMint} | Metaplex data: Name=${tokenName}, Symbol=${tokenSymbol}`);
      } catch (metaplexError) {
        logger.error(`[❌ METAPLEX-ERROR] ${shortMint} | Metaplex fetch failed: ${metaplexError instanceof Error ? metaplexError.message : String(metaplexError)}`);
        // If we can't get a symbol, we'll return true to skip this token
        return true;
      }
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
        logger.info(`[🛑 NOT-RUNNING] ${shortMint} | Bot not running or outside working hours`);
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
          if (err) {
            logger.error(`[❌ LOGS-ERROR] Error in onLogs handler: ${err}`);
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
            
            // Get transaction details
            const txn = await connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });

            if (!txn) {
              logger.error(`[❌ TX-ERROR] Failed to get transaction details for ${signature.slice(0, 8)}...`);
              return;
            }

            // Extract account information
            //@ts-ignore
            const accountKeys = txn?.transaction.message.instructions.find((ix) => ix.programId.toString() === PUMP_WALLET.toBase58())?.accounts as PublicKey[];

            if (!accountKeys || accountKeys.length < 8) {
              logger.error(`[❌ KEY-ERROR] Invalid account keys for ${signature.slice(0, 8)}...`);
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
            
            if (txn.blockTime && txn.meta) {
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
                
                if (SniperBotConfig.getBuyConfig().duplicates.enabled === true) {
                  isDuplicated = await checkDuplicates(mint.toBase58());
                } else {
                  // Still add to database, but don't filter
                  checkDuplicates(mint.toBase58());
                }
                
                if (isDuplicated) {
                  logger.info(`[❌ DUPLICATE] ${shortMint} | Duplicate token found, skipping`);
                  return;
                }
                
                // Check if bot is running
                if (!isRunning() || !isWorkingTime()) {
                  logger.info(`[🛑 NOT-RUNNING] ${shortMint} | Bot not running or outside working hours`);
                  return;
                }
                
                const created_timestamp = txn.blockTime * 1000;
                logger.info(`[🎯 NEW-TOKEN] ${shortMint} | Starting monitoring process | Created: ${new Date(created_timestamp).toISOString()}`);
                
                // Update buy monitor cycle from config
                BUY_MONITOR_CYCLE = SniperBotConfig.getBuyIntervalTime();
                
                // Start monitoring the token
                monitorToken(mint.toBase58(), pumpData, user, created_timestamp);
            } else {
                logger.error(`[❌ TX-DATA-ERROR] ${shortMint} | Missing transaction data: blockTime or meta`);
            }
          }
        } catch (e: any) {
          logger.error(`[❌ LOGS-HANDLER-ERROR] Error processing logs: ${e.message}`);
          if (e.stack) {
            logger.error(`[❌ STACK-TRACE] ${e.stack.split('\n').slice(0, 3).join(' | ')}`);
          }
        }
      },
      COMMITMENT_LEVEL
    );
    
    logger.info(`[🔌 CONNECTED] Sniper service successfully connected to Solana network`);
  } catch (e: any) {
    logger.error(`[❌ CONNECTION-ERROR] Failed to connect sniper service: ${e.message}`);
    if (e.stack) {
      logger.error(`[❌ STACK-TRACE] ${e.stack.split('\n').slice(0, 3).join(' | ')}`);
    }
  }
}