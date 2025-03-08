import { LiquidityPoolKeys } from "@raydium-io/raydium-sdk";
import { START_TXT, wallet } from "../../config";
import { ITransaction, SniperTxns } from "../../models/SniperTxns";
import { getPumpTokenPriceUSD, getTokenBalance } from "../pumpfun/pumpfun";
import { getWalletTokens } from "../assets/assets";
import { SniperBotConfig } from "../setting/botConfigClass";
import logger from "../../logs/logger";
import { sellTokenSwap } from "../../utils/utils";
import { TOKEN_DECIMALS, TOTAL_SUPPLY } from "../../utils/constants";
import { PriceMonitor } from "./priceMonitor";

const SELL_MONITOR_CYCLE = 2 * 1000;

const tokenSellingStep: Map<string, number> = new Map();
const tokenCreatedTime: Map<string, number> = new Map();
// Map to store PriceMonitor instances
const priceMonitors: Map<string, PriceMonitor> = new Map();

const poolKeyMap: Map<string, LiquidityPoolKeys> = new Map();
export function getPoolKeyMap(mint: string) {
  return poolKeyMap.get(mint);
}
export function setPoolKeyMap(mint: string, poolKey: LiquidityPoolKeys) {
  poolKeyMap.set(mint, poolKey);
}

// Helper function to format time elapsed
function formatTimeElapsed(ms: number): string {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// Helper function to get token short name for logs
function getTokenShortName(mint: string): string {
  return `${mint.slice(0, 8)}...`;
}

let botSellConfig = SniperBotConfig.getSellConfig();

const tokenMonitorThread2Sell = async (mint: string) => {
  const shortMint = getTokenShortName(mint);
  logger.info(`[🔍 MONITOR] Starting monitor thread for token ${shortMint}`);

  try {
    const tokenTxns = await SniperTxns.find({ mint }).sort({ date: -1 });
    const buyTx: ITransaction | undefined = tokenTxns.find((txn) => txn.swap === "BUY");

    if (!buyTx) {
      logger.warn(`[❌ ERROR] No buy transaction found for token ${shortMint}`);
      tokenSellingStep.delete(mint);
      return;
    }

    const investedPrice_usd = Number(buyTx.swapPrice_usd);
    const investedAmount = Number(buyTx.swapAmount) * 10 ** TOKEN_DECIMALS;
    
    if (!investedPrice_usd) {
      logger.warn(`[❌ ERROR] Invalid invested price for token ${shortMint}`);
      tokenSellingStep.delete(mint);
      return;
    }

    const selling_step = tokenTxns.length - 1;
    tokenSellingStep.set(mint, selling_step);
    
    // Set creation time if not already set
    if (!tokenCreatedTime.has(mint)) {
      tokenCreatedTime.set(mint, buyTx.txTime);
    }
    
    const tokenAge = Date.now() - (buyTx.txTime || Date.now());
    logger.info(`[📊 INFO] ${shortMint} | Age: ${formatTimeElapsed(tokenAge)} | Buy Price: $${investedPrice_usd.toFixed(6)} | Initial Amount: ${(investedAmount / 10 ** TOKEN_DECIMALS).toFixed(4)} | Sell History: ${selling_step} txns`);

    try {
      const { price: initialPrice_usd } = await getPumpTokenPriceUSD(mint);
      
      // Initialize PriceMonitor once, outside of the MonitorThread
      const durationSec = typeof botSellConfig.mcChange.duration === 'number' ? 
        (botSellConfig.mcChange.duration > 1000 ? botSellConfig.mcChange.duration / 1000 : botSellConfig.mcChange.duration) : 
        60; // Default to 60 seconds if undefined
      
      logger.info(`[⚙️ CONFIG] ${shortMint} | Exit Loss: -${botSellConfig.lossExitPercent}% | Min Growth: +${botSellConfig.mcChange.percentValue}% in ${durationSec}s`);
      
      const priceMonitor = new PriceMonitor(
        botSellConfig.mcChange.percentValue,
        durationSec,
        initialPrice_usd,
        mint
      );
      
      // Store the monitor in the map for later use
      priceMonitors.set(mint, priceMonitor);

      async function MonitorThread() {
        try {
          const now = Date.now();
          const curTokenAmount = await getTokenBalance(wallet.publicKey.toBase58(), mint);
          
          if (curTokenAmount === 0) {
            logger.info(`[🚫 ZERO] ${shortMint} | Current token amount is zero, stopping monitor`);
            tokenSellingStep.delete(mint);
            priceMonitors.delete(mint);
            return;
          }

          const selling_step = tokenSellingStep.get(mint)!;
          if (selling_step >= 4) {
            logger.info(`[🏁 COMPLETE] ${shortMint} | All sell steps completed (${selling_step}/4)`);
            tokenSellingStep.delete(mint);
            priceMonitors.delete(mint);
            return;
          }

          try {
            const { price: currentPrice_usd } = await getPumpTokenPriceUSD(mint);
            
            // Log periodic detailed status (every 5 minutes)
            if (Math.floor(now / 300000) % 1 === 0 && Math.floor(now / 1000) % 300 < 1) {
              const monitorStatus = priceMonitor?.getStatus();
              if (monitorStatus) {
                const remainingTime = priceMonitor?.getRemainingTimeSeconds() || 0;
                logger.info(`[⏱️ GROWTH-MONITOR] ${shortMint} | Progress: ${monitorStatus.elapsedPercent.toFixed(1)}% | Remaining: ${formatTimeElapsed(remainingTime * 1000)} | Required Growth: ${monitorStatus.requiredGrowthPercent.toFixed(2)}%`);
              }
            }
            
            // Periodic logging of token status (every 3 minutes)
            const just_now = Math.floor(now / 1000);
            if(just_now % 180 === 0) {
              const ageFormatted = formatTimeElapsed(now - (buyTx?.txTime || now));
              const priceChangePercent = ((currentPrice_usd / investedPrice_usd) - 1) * 100;
              logger.info(`[📈 STATUS] ${shortMint} | Age: ${ageFormatted} | Price: $${currentPrice_usd.toFixed(6)} (${priceChangePercent > 0 ? "+" : ""}${priceChangePercent.toFixed(2)}%)`);
            }

            // Check if price failed to increase by the threshold percentage within the monitored duration
            if (priceMonitor && priceMonitor.shouldSell(currentPrice_usd)) {
              logger.info(`[💰 SELL-SIGNAL] ${shortMint} | Insufficient price growth (less than ${botSellConfig.mcChange.percentValue}% in ${durationSec}s) | Current: $${currentPrice_usd.toFixed(6)}`);
              
              try {
                const txHash = await sellTokenSwap(mint, curTokenAmount, true, false);
                
                if (txHash) {
                  logger.info(`[✅ SOLD] ${shortMint} | Sold due to insufficient price growth | Amount: ${curTokenAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)} | TxHash: ${txHash.slice(0, 8)}...`);
                  tokenSellingStep.delete(mint);
                  priceMonitors.delete(mint);
                  return;
                } else {
                  logger.error(`[❌ SELL-ERROR] ${shortMint} | Failed to sell due to price stagnation`);
                }
              } catch (error) {
                logger.error(`[❌ SELL-ERROR] ${shortMint} | Error while selling: ${error instanceof Error ? error.message : String(error)}`);
              }
            }

            const raisePercent = ((currentPrice_usd / investedPrice_usd) - 1) * 100;
            
            // Check for stop loss
            if (raisePercent < 0 && Math.abs(raisePercent) > botSellConfig.lossExitPercent) {
              logger.info(`[💰 SELL-SIGNAL] ${shortMint} | Price dropped below stop loss (${raisePercent.toFixed(2)}% < -${botSellConfig.lossExitPercent}%)`);
              
              try {
                const txHash = await sellTokenSwap(mint, curTokenAmount, true, false);
                if (txHash) {
                  logger.info(`[✅ SOLD] ${shortMint} | Sold due to stop loss | Amount: ${curTokenAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)} | TxHash: ${txHash.slice(0, 8)}...`);
                  tokenSellingStep.delete(mint);
                  priceMonitors.delete(mint);
                  return;
                } else {
                  logger.error(`[❌ FAILED] ${shortMint} | Failed to sell tokens due to stop loss`);
                }
              } catch (error) {
                logger.error(`[❌ SELL-ERROR] ${shortMint} | Error during stop loss sell: ${error instanceof Error ? error.message : String(error)}`);
              }
            }

            // Check progressive selling conditions
            const sellRules = botSellConfig.saleRules;
            const chk_step = tokenSellingStep.get(mint)!;
            const sellSumPercent = sellRules.reduce((acc, rule) => acc + rule.percent, 0);

            if (raisePercent >= sellRules[chk_step].revenue) {
              const sellPercent = sellRules[chk_step].percent;
              let remainPercent = sellRules.slice(chk_step + 1).reduce((acc, r) => acc + r.percent, 0);

              const sellAmount = remainPercent === 0 && sellSumPercent === 100
                ? curTokenAmount // Sell all remaining amount
                : Math.min((investedAmount * sellPercent) / 100, investedAmount);

              logger.info(`[💰 STEP-SELL] ${shortMint} | Step ${chk_step + 1}/4 | Target: ${sellRules[chk_step].revenue.toFixed(2)}% | Current: ${raisePercent.toFixed(2)}% | Selling: ${sellPercent}% (${sellAmount / 10 ** TOKEN_DECIMALS} tokens)`);
              
              try {
                const txHash = await sellTokenSwap(mint, sellAmount, chk_step === 3, false);

                if (txHash) {
                  logger.info(`[✅ STEP-SOLD] ${shortMint} | Successfully executed step ${chk_step + 1} sell | Amount: ${sellAmount / 10 ** TOKEN_DECIMALS} | TxHash: ${txHash.slice(0, 8)}...`);
                  tokenSellingStep.set(mint, chk_step + 1);
                } else {
                  logger.error(`[❌ FAILED] ${shortMint} | Failed to execute step ${chk_step + 1} sell`);
                }
              } catch (error) {
                logger.error(`[❌ SELL-ERROR] ${shortMint} | Error during step ${chk_step + 1} sell: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          } catch (priceError) {
            logger.error(`[❌ PRICE-ERROR] ${shortMint} | Failed to get current price: ${priceError instanceof Error ? priceError.message : String(priceError)}`);
          }
          
          setTimeout(MonitorThread, SELL_MONITOR_CYCLE);
        } catch (threadError) {
          logger.error(`[❌ ERROR] Monitor thread error for ${shortMint}: ${threadError instanceof Error ? threadError.message : String(threadError)}`);
          setTimeout(MonitorThread, SELL_MONITOR_CYCLE);
        }
      }
      
      MonitorThread();
    } catch (initError) {
      logger.error(`[❌ INIT-ERROR] Failed to initialize price monitor for ${shortMint}: ${initError instanceof Error ? initError.message : String(initError)}`);
    }
  } catch (error) {
    logger.error(`[❌ SETUP-ERROR] Failed to set up monitor for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const sellMonitorService = async () => {
  logger.info(`${START_TXT.sell} ✨ PumpFun Sell monitor service started at ${new Date().toISOString()}`);
  
  async function monitorLoop() {
    try {
      botSellConfig = SniperBotConfig.getSellConfig();
      const tokens = await getWalletTokens(wallet.publicKey);
      
      if(tokens.length > 0) {
        logger.info(`[🔎 SCANNING] Found ${tokens.length} tokens in wallet`);
        
        const unmonitoredTokens = tokens.filter(token => 
          !tokenSellingStep.has(token.mint) && token.amount > 0
        );
        
        if (unmonitoredTokens.length > 0) {
          logger.info(`[🆕 NEW] Starting monitors for ${unmonitoredTokens.length} new tokens`);
          
          await Promise.all(
            unmonitoredTokens.map(token => tokenMonitorThread2Sell(token.mint))
          );
        }
      }
      
      setTimeout(monitorLoop, SELL_MONITOR_CYCLE);
    } catch (error) {
      logger.error(`[❌ SERVICE ERROR] Sell monitor service error: ${error instanceof Error ? error.message : String(error)}`);
      setTimeout(monitorLoop, SELL_MONITOR_CYCLE);
    }
  }
  
  monitorLoop();
};