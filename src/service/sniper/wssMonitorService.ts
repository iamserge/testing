import { AccountInfo, Context, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connection, wallet, START_TXT } from "../../config";
import logger from "../../logs/logger";
import { getTokenDataforAssets, getWalletTokens } from "../assets/assets";
import { getTokenBalance, getPumpData, getPumpTokenPriceUSD } from "../pumpfun/pumpfun";
import { SniperBotConfig } from "../setting/botConfigClass";
import { sellTokenSwap } from "../../utils/utils";
import { fetchPoolInfoByMint } from "../swap/raydium/utils";
import { TOKEN_DECIMALS, TOTAL_SUPPLY } from "../../utils/constants";
import { ITransaction, SniperTxns } from "../../models/SniperTxns";

// Define the PriceData interface for price monitoring
interface PriceData {
  initialPrice: number;
  threshold: number;
  duration: number;
  startTime: number;
}

// Define the PendingTransaction interface for tracking transactions
interface PendingTransaction {
  txHash: string;
  amount: number;
  timestamp: number;
  sellStep?: number;
  isStagnationSell?: boolean;
}

// Maps for tracking token state
const tokenSellingStep: Map<string, number> = new Map();
const tokenCreatedTime: Map<string, number> = new Map();
const statusLogIntervals: Map<string, NodeJS.Timeout> = new Map();
const tokenPriceData: Map<string, PriceData> = new Map();
const pendingTransactions: Map<string, PendingTransaction[]> = new Map();

// REMOVED: tokenSellingLock map is removed to prevent locking tokens

// New map to store direct buy transaction info (without DB lookups)
const tokenBuyTxInfo: Map<string, Partial<ITransaction>> = new Map();

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

export class WssMonitorService {
  private static monitoredTokens: Map<string, PublicKey> = new Map();
  private static activeSubscriptions: Map<string, number> = new Map();
  private static isInitialized: boolean = false;
  private static syncInterval: NodeJS.Timeout | null = null;
  private static activeMonitorInterval: NodeJS.Timeout | null = null;
  private static memoryMonitorInterval: NodeJS.Timeout | null = null;

  // REMOVED: All lock-related methods and properties

  /**
   * Initialize the WebSocket monitoring service
   */
  public static initialize(): void {
    if (this.isInitialized) return;
    
    logger.info(`${START_TXT.sell} ✨ WebSocket-based Sell monitor service started at ${new Date().toISOString()} (NO LOCKS ENABLED)`);
    this.isInitialized = true;
    
    // Initialize maps
    pendingTransactions.clear();
    tokenBuyTxInfo.clear();
    
    // Initial sync of monitored tokens
    this.syncMonitoredTokens();
    
    // Set up periodic sync to ensure we're monitoring all wallet tokens
    this.syncInterval = setInterval(() => this.syncMonitoredTokens(), 30000); // Check every 30 seconds for new tokens (more frequent)
    
    // Set up active price monitoring every 1 second (more frequent than before)
    this.startActiveMonitoring();

    this.memoryMonitorInterval = setInterval(() => {
      try {
        // Get active token count
        const activeTokenCount = this.monitoredTokens.size;
        
        // Check memory usage
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024 * 100) / 100;
        
        logger.info(`[🧠 MEMORY] Active tokens: ${activeTokenCount} | Heap used: ${heapUsedMB}MB`);
        
        // If memory usage is high, force cleanup of older monitoring operations
        if (heapUsedMB > 500) { // 500MB threshold
          logger.warn(`[⚠️ HIGH-MEMORY] Initiating cleanup of older token monitors`);
          this.cleanupOldestMonitors(5); // Remove 5 oldest monitors
        }
      } catch (error) {
        logger.error(`[❌ MEMORY-ERROR] Error monitoring memory: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 300000);
  }

  /**
   * Start active monitoring to check token prices more frequently (every 1 second)
   */
  private static startActiveMonitoring(): void {
    if (this.activeMonitorInterval) {
      clearInterval(this.activeMonitorInterval);
    }
    
    logger.info(`[⏱️ ACTIVE-MONITOR] Starting frequent price checks every 1 second (no locks)`);
    
    this.activeMonitorInterval = setInterval(async () => {
      try {
        // Check all monitored tokens
        for (const [mintAddress, _] of this.monitoredTokens) {
          const shortMint = getTokenShortName(mintAddress);
          
          try {
            // REMOVED: Check for active lock - always proceed with evaluation
            
            // Direct evaluation without queuing or debouncing
            try {
              const tokenData = await getTokenDataforAssets(mintAddress);
              const { price: currentPrice_usd } = await getPumpTokenPriceUSD(mintAddress);
              
              if (tokenData && currentPrice_usd > 0) {
                // Check if duration has elapsed and evaluate sell conditions
                await this.evaluateSellConditions(mintAddress, tokenData, currentPrice_usd);
              }
            } catch (error) {
              logger.error(`[❌ ACTIVE-EVAL-ERROR] Error in evaluation for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
            }
          } catch (tokenError) {
            logger.error(`[❌ ACTIVE-CHECK-ERROR] Error checking token ${shortMint}: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`);
          }
        }
      } catch (error) {
        logger.error(`[❌ ACTIVE-MONITOR-ERROR] Error in active monitoring loop: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 1000); // Check every 1 second (more aggressive monitoring)
  }

  /**
   * Synchronize monitored tokens with tokens in the wallet
   */
  private static async syncMonitoredTokens(): Promise<void> {
    try {
      const tokens = await getWalletTokens(wallet.publicKey);
      
      if (tokens.length > 0) {
        logger.info(`[🔎 SCANNING - WSS] Found ${tokens.length} tokens in wallet`);
        
        const unmonitoredTokens = tokens.filter(token => 
          !this.monitoredTokens.has(token.mint) && token.amount > 0
        );
        
        if (unmonitoredTokens.length > 0) {
          logger.info(`[🆕 NEW] Starting WebSocket monitors for ${unmonitoredTokens.length} new tokens`);
          
          for (const token of unmonitoredTokens) {
            await this.startMonitoring(token.mint);
          }
        }
      }
    } catch (error) {
      logger.error(`[❌ SYNC-ERROR] Error synchronizing monitored tokens: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Start monitoring a token with direct transaction data
   */
  public static async startMonitoringWithData(
    mintAddress: string, 
    buyTxInfo: Partial<ITransaction>
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      // Store the buy transaction info directly in memory
      tokenBuyTxInfo.set(mintAddress, buyTxInfo);
      logger.info(`[💾 DIRECT-DATA] ${shortMint} | Stored direct buy transaction data. Price: $${buyTxInfo.swapPrice_usd?.toFixed(6)}, Amount: ${buyTxInfo.swapAmount?.toFixed(6)}`);
      
      // Set creation time to now if not already set
      if (!tokenCreatedTime.has(mintAddress)) {
        tokenCreatedTime.set(mintAddress, buyTxInfo.txTime || Date.now());
      }
      
      // Initialize selling step to 0 (first purchase)
      tokenSellingStep.set(mintAddress, 0);
      
      // Now start monitoring with direct data
      await this.startMonitoringWithDirectData(mintAddress);
    } catch (error) {
      logger.error(`[❌ DIRECT-MONITOR-ERROR] ${shortMint} | Error starting monitoring with direct data: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Internal method to start monitoring with direct data
   */
  private static async startMonitoringWithDirectData(mintAddress: string): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      // Add a timestamp to track when monitoring started
      const monitorStartTime = Date.now();
      
      if (this.activeSubscriptions.has(mintAddress)) {
        logger.info(`[⚠️ DUPLICATE] Already monitoring ${shortMint} - skipping initialization`);
        return;
      }
  
      const mint = new PublicKey(mintAddress);
      this.monitoredTokens.set(mintAddress, mint);
      
      // Initialize pending transactions array
      pendingTransactions.set(mintAddress, []);
      
      logger.info(`[🔍 MONITOR] Starting WebSocket monitoring for token: ${shortMint} (source: direct handoff)`);
  
      // Initialize token data with direct info
      await this.initializeDirectTokenMonitoring(mintAddress);
  
      // Subscribe to the token's liquidity pool account changes
      const poolData = await this.findLiquidityPoolForToken(mintAddress);
      if (poolData && poolData.poolAddress) {
        const subscriptionId = connection.onAccountChange(
          poolData.poolAddress,
          (accountInfo, context) => this.handlePoolAccountChange(mintAddress, accountInfo, context),
          'confirmed'
        );
        this.activeSubscriptions.set(mintAddress, subscriptionId);
        
        const initTimeMs = Date.now() - monitorStartTime;
        logger.info(`[🔌 CONNECTED] WebSocket subscription established for ${shortMint} (pool account) in ${initTimeMs}ms`);
      } else {
        // Fallback to program subscription if pool not found
        this.subscribeToTokenProgram(mintAddress);
        
        const initTimeMs = Date.now() - monitorStartTime;
        logger.info(`[🔌 CONNECTED] Token program subscription established for ${shortMint} in ${initTimeMs}ms`);
      }
    } catch (error) {
      logger.error(`[❌ MONITOR-ERROR] Error starting monitoring with direct data for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Start monitoring a token (normal method, tries to load data from DB)
   */
  public static async startMonitoring(mintAddress: string): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      // Check if we already have direct data for this token
      if (tokenBuyTxInfo.has(mintAddress)) {
        logger.info(`[🔄 DIRECT-DATA] ${shortMint} | Using existing direct data instead of database lookup`);
        return this.startMonitoringWithDirectData(mintAddress);
      }
      
      // Add a timestamp to track when monitoring started
      const monitorStartTime = Date.now();
      
      if (this.activeSubscriptions.has(mintAddress)) {
        logger.info(`[⚠️ DUPLICATE] Already monitoring ${shortMint} - skipping initialization`);
        return;
      }
  
      const mint = new PublicKey(mintAddress);
      this.monitoredTokens.set(mintAddress, mint);
      
      // Initialize pending transactions array
      pendingTransactions.set(mintAddress, []);
      
      // Enhance logging to track the source of initialization
      const initSource = tokenCreatedTime.has(mintAddress) ? "periodic scan" : "database lookup";
      logger.info(`[🔍 MONITOR] Starting WebSocket monitoring for token: ${shortMint} (source: ${initSource})`);
  
      // Initialize token data from database
      await this.initializeTokenMonitoring(mintAddress);
  
      // Subscribe to the token's liquidity pool account changes
      const poolData = await this.findLiquidityPoolForToken(mintAddress);
      if (poolData && poolData.poolAddress) {
        const subscriptionId = connection.onAccountChange(
          poolData.poolAddress,
          (accountInfo, context) => this.handlePoolAccountChange(mintAddress, accountInfo, context),
          'confirmed'
        );
        this.activeSubscriptions.set(mintAddress, subscriptionId);
        
        const initTimeMs = Date.now() - monitorStartTime;
        logger.info(`[🔌 CONNECTED] WebSocket subscription established for ${shortMint} (pool account) in ${initTimeMs}ms`);
      } else {
        // Fallback to program subscription if pool not found
        this.subscribeToTokenProgram(mintAddress);
        
        const initTimeMs = Date.now() - monitorStartTime;
        logger.info(`[🔌 CONNECTED] Token program subscription established for ${shortMint} in ${initTimeMs}ms`);
      }
    } catch (error) {
      logger.error(`[❌ MONITOR-ERROR] Error starting monitoring for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
      throw error; // Re-throw to allow calling code to handle it
    }
  }

  /**
   * Initialize token monitoring data from direct buy info (no DB lookup)
   */
  private static async initializeDirectTokenMonitoring(mintAddress: string): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      const startTime = Date.now();
      
      // Get the direct buy transaction info
      const buyTx = tokenBuyTxInfo.get(mintAddress);
      
      if (!buyTx) {
        logger.error(`[❌ ERROR] No direct buy transaction data found for token ${shortMint}`);
        return;
      }
      
      const investedPrice_usd = Number(buyTx.swapPrice_usd || 0);
      const investedAmount = Number(buyTx.swapAmount || 0) * 10 ** TOKEN_DECIMALS;
      
      if (!investedPrice_usd) {
        logger.error(`[❌ ERROR] Invalid invested price in direct data for token ${shortMint}`);
        return;
      }
      
      // Set selling step to 0 (first step)
      tokenSellingStep.set(mintAddress, 0);
      
      // Set creation time if not already set
      if (!tokenCreatedTime.has(mintAddress)) {
        tokenCreatedTime.set(mintAddress, buyTx.txTime || Date.now());
      }
      
      const tokenAge = Date.now() - (buyTx.txTime || Date.now());
      const ageFormatted = formatTimeElapsed(tokenAge);
      
      logger.info(`[📊 INFO] ${shortMint} | Age: ${ageFormatted} | Buy Price: $${investedPrice_usd.toFixed(6)} | Initial Amount: ${(investedAmount / 10 ** TOKEN_DECIMALS).toFixed(4)} | Direct Data Used`);
      
      // Initialize price monitoring
      try {
        const { price: initialPrice_usd } = await getPumpTokenPriceUSD(mintAddress);
        
        const botSellConfig = SniperBotConfig.getSellConfig();
        const durationSec = typeof botSellConfig.mcChange?.duration === 'number' ? 
          (botSellConfig.mcChange.duration > 1000 ? botSellConfig.mcChange.duration / 1000 : botSellConfig.mcChange.duration) : 
          10; // Default to 10 seconds if undefined
        
        const percentValue = typeof botSellConfig.mcChange?.percentValue === 'number' ? 
          botSellConfig.mcChange.percentValue : 25; // Default to 25% if undefined
        
        logger.info(`[⚙️ CONFIG] ${shortMint} | Exit Loss: -${botSellConfig.lossExitPercent}% | Min Growth: +${percentValue}% in ${durationSec}s | Profit Targets: ${botSellConfig.saleRules.map(r => `+${r.revenue}%`).join(', ')}`);
        
        // Create price data for monitoring
        const priceData: PriceData = {
          initialPrice: initialPrice_usd,
          threshold: percentValue / 100,
          duration: durationSec * 1000, // Convert to milliseconds
          startTime: Date.now()
        };
        
        // Store the price data in the map
        tokenPriceData.set(mintAddress, priceData);
        
        const initTimeMs = Date.now() - startTime;
        logger.info(`[🔄 PRICE-MONITOR] ${shortMint} | Created with initial price $${initialPrice_usd.toFixed(6)}, threshold ${percentValue}%, duration ${durationSec}s | Init time: ${initTimeMs}ms`);
      } catch (priceError) {
        logger.error(`[❌ PRICE-ERROR] Failed to initialize price monitoring for ${shortMint}: ${priceError instanceof Error ? priceError.message : String(priceError)}`);
      }
      
      // Set up periodic status logging (every 60 seconds)
      this.setupStatusLogging(mintAddress, buyTx.txTime || Date.now(), investedPrice_usd);
      
    } catch (error) {
      logger.error(`[❌ DIRECT-INIT-ERROR] Error initializing direct token data for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Initialize token monitoring data from database
   */
  private static async initializeTokenMonitoring(mintAddress: string): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      const startTime = Date.now();
      
      // Get token transaction history from database
      const tokenTxns = await SniperTxns.find({ mint: mintAddress }).sort({ date: -1 });
      const buyTx: ITransaction | undefined = tokenTxns.find((txn) => txn.swap === "BUY");
  
      if (!buyTx) {
        logger.warn(`[❌ DB-ERROR] No buy transaction found in database for token ${shortMint}`);
        // Check if we have direct data as fallback
        if (tokenBuyTxInfo.has(mintAddress)) {
          logger.info(`[🔄 FALLBACK] ${shortMint} | Using direct data as fallback for missing database record`);
          return this.initializeDirectTokenMonitoring(mintAddress);
        }
        
        tokenSellingStep.delete(mintAddress);
        return;
      }
  
      const investedPrice_usd = Number(buyTx.swapPrice_usd);
      const investedAmount = Number(buyTx.swapAmount) * 10 ** TOKEN_DECIMALS;
      
      if (!investedPrice_usd) {
        logger.warn(`[❌ DB-ERROR] Invalid invested price in database for token ${shortMint}`);
        tokenSellingStep.delete(mintAddress);
        return;
      }
  
      const selling_step = tokenTxns.length - 1;
      tokenSellingStep.set(mintAddress, selling_step);
      
      // Set creation time if not already set
      if (!tokenCreatedTime.has(mintAddress)) {
        tokenCreatedTime.set(mintAddress, buyTx.txTime);
        logger.info(`[🔄 DB-DATA] ${shortMint} | Using database transaction time: ${new Date(buyTx.txTime).toISOString()}`);
      }
      
      const tokenAge = Date.now() - (buyTx.txTime || Date.now());
      const ageFormatted = formatTimeElapsed(tokenAge);
      
      logger.info(`[📊 INFO] ${shortMint} | Age: ${ageFormatted} | Buy Price: $${investedPrice_usd.toFixed(6)} | Initial Amount: ${(investedAmount / 10 ** TOKEN_DECIMALS).toFixed(4)} | Sell History: ${selling_step} txns`);
      
      // Initialize price monitoring
      try {
        const { price: initialPrice_usd } = await getPumpTokenPriceUSD(mintAddress);
        
        const botSellConfig = SniperBotConfig.getSellConfig();
        const durationSec = typeof botSellConfig.mcChange?.duration === 'number' ? 
          (botSellConfig.mcChange.duration > 1000 ? botSellConfig.mcChange.duration / 1000 : botSellConfig.mcChange.duration) : 
          10; // Default to 10 seconds if undefined
        
        const percentValue = typeof botSellConfig.mcChange?.percentValue === 'number' ? 
          botSellConfig.mcChange.percentValue : 25; // Default to 25% if undefined
        
        logger.info(`[⚙️ CONFIG] ${shortMint} | Exit Loss: -${botSellConfig.lossExitPercent}% | Min Growth: +${percentValue}% in ${durationSec}s | Profit Targets: ${botSellConfig.saleRules.map(r => `+${r.revenue}%`).join(', ')}`);
        
        // Create price data for monitoring
        const priceData: PriceData = {
          initialPrice: initialPrice_usd,
          threshold: percentValue / 100,
          duration: durationSec * 1000, // Convert to milliseconds
          startTime: Date.now()
        };
        
        // Store the price data in the map
        tokenPriceData.set(mintAddress, priceData);
        
        const initTimeMs = Date.now() - startTime;
        logger.info(`[🔄 PRICE-MONITOR] ${shortMint} | Created with initial price $${initialPrice_usd.toFixed(6)}, threshold ${percentValue}%, duration ${durationSec}s | Init time: ${initTimeMs}ms`);
      } catch (priceError) {
        logger.error(`[❌ PRICE-ERROR] Failed to initialize price monitoring for ${shortMint}: ${priceError instanceof Error ? priceError.message : String(priceError)}`);
      }
  
      // Set up periodic status logging (every 60 seconds)
      this.setupStatusLogging(mintAddress, buyTx.txTime, investedPrice_usd);
      
    } catch (error) {
      logger.error(`[❌ DB-INIT-ERROR] Error initializing token data from database for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if the token should be sold based on price stagnation
   */
  private static shouldSellDueToStagnation(mintAddress: string, currentPrice: number): boolean {
    const shortMint = getTokenShortName(mintAddress);
    const priceData = tokenPriceData.get(mintAddress);
    
    if (!priceData) {
      logger.warn(`[⚠️ NO-PRICE-DATA] ${shortMint} | No price data found for evaluation`);
      return false;
    }
    
    const currentTime = Date.now();
    const elapsedTime = currentTime - priceData.startTime;
    
    // Aggressively check if duration has elapsed
    if (elapsedTime >= priceData.duration) {
      // Protect against division by zero or negative initial price
      if (priceData.initialPrice <= 0) {
        logger.warn(`[⚠️ PRICE-ISSUE] ${shortMint} | Initial price is ${priceData.initialPrice}. Setting to current price and resetting timer.`);
        priceData.initialPrice = Math.max(0.000000001, currentPrice); // Avoid zero
        priceData.startTime = currentTime;
        return false;
      }
      
      const priceChange = (currentPrice - priceData.initialPrice) / priceData.initialPrice;
      const priceChangePercent = priceChange * 100;
      const minRequiredPercent = priceData.threshold * 100;
      
      logger.info(`[⏱️ EVALUATION] ${shortMint} | Duration elapsed (${formatTimeElapsed(elapsedTime)}). Price change: ${priceChangePercent.toFixed(2)}%, Required: ${minRequiredPercent.toFixed(2)}%`);
      
      if (priceChange < priceData.threshold) {
        logger.info(`[🚨 SELL-TRIGGER] ${shortMint} | Insufficient price growth (${priceChangePercent.toFixed(2)}% < required ${minRequiredPercent.toFixed(2)}%)`);
        return true;
      }
      
      logger.info(`[🔄 RESET-MONITOR] ${shortMint} | Resetting monitor with new initial price $${currentPrice.toFixed(6)}`);
      priceData.initialPrice = currentPrice;
      priceData.startTime = currentTime;
      return false;
    }
    
    // Log progress if we're over 70% of the way there (more frequent logging)
    if (elapsedTime > priceData.duration * 0.7) {
      const priceChange = (currentPrice - priceData.initialPrice) / priceData.initialPrice;
      const priceChangePercent = priceChange * 100;
      const minRequiredPercent = priceData.threshold * 100;
      const percentComplete = (elapsedTime / priceData.duration) * 100;
      
      logger.info(`[⏳ APPROACHING] ${shortMint} | Progress: ${percentComplete.toFixed(1)}% | Current Growth: ${priceChangePercent.toFixed(2)}% | Required: ${minRequiredPercent.toFixed(2)}%`);
    }
    
    return false;
  }
  
  /**
   * Get status of price monitoring for a token
   */
  private static getPriceMonitorStatus(mintAddress: string): { 
    initialPrice: number;
    elapsedPercent: number;
    requiredGrowthPercent: number;
    remainingTimeSeconds: number;
  } | null {
    const priceData = tokenPriceData.get(mintAddress);
    if (!priceData) return null;
    
    const now = Date.now();
    const elapsed = now - priceData.startTime;
    const remaining = Math.max(0, priceData.duration - elapsed);
    
    return {
      initialPrice: priceData.initialPrice,
      elapsedPercent: Math.min(100, (elapsed / priceData.duration) * 100),
      requiredGrowthPercent: priceData.threshold * 100,
      remainingTimeSeconds: Math.floor(remaining / 1000)
    };
  }

  /**
   * Set up periodic status logging for a token
   */
  private static setupStatusLogging(mintAddress: string, buyTime: number | undefined, buyPrice: number): void {
    const shortMint = getTokenShortName(mintAddress);
    
    // Clear any existing interval
    if (statusLogIntervals.has(mintAddress)) {
      clearInterval(statusLogIntervals.get(mintAddress)!);
    }
    
    // Set up new interval (log every 60 seconds)
    const interval = setInterval(async () => {
      try {
        const { price: currentPrice_usd } = await getPumpTokenPriceUSD(mintAddress);
        const ageFormatted = formatTimeElapsed(Date.now() - (buyTime || Date.now()));
        const priceChangePercent = ((currentPrice_usd / buyPrice) - 1) * 100;
        const mcUsd = currentPrice_usd * TOTAL_SUPPLY;
        
        // Log basic status
        logger.info(`[📈 STATUS] ${shortMint} | Age: ${ageFormatted} | Price: $${currentPrice_usd.toFixed(6)} (${priceChangePercent > 0 ? "+" : ""}${priceChangePercent.toFixed(2)}%) | MC: $${(mcUsd/1000).toFixed(1)}K`);
        
        // Log price monitor status if available
        const status = this.getPriceMonitorStatus(mintAddress);
        if (status) {
          logger.info(`[⏱️ GROWTH-MONITOR] ${shortMint} | Progress: ${status.elapsedPercent.toFixed(1)}% | Remaining: ${formatTimeElapsed(status.remainingTimeSeconds * 1000)} | Required Growth: ${status.requiredGrowthPercent.toFixed(2)}%`);
        }
      } catch (error) {
        logger.error(`[❌ STATUS-ERROR] Error logging status for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 60000); // Every 60 seconds
    
    statusLogIntervals.set(mintAddress, interval);
  }

  /**
   * Adds a pending transaction to the tracking map
   * We still track pending transactions for reference but don't use it to block new sells
   */
  private static addPendingTransaction(
    mintAddress: string, 
    txHash: string, 
    amount: number, 
    sellStep?: number,
    isStagnationSell = false
  ): void {
    const shortMint = getTokenShortName(mintAddress);
    const pending = pendingTransactions.get(mintAddress) || [];
    
    pending.push({
      txHash,
      amount,
      timestamp: Date.now(),
      sellStep,
      isStagnationSell
    });
    
    pendingTransactions.set(mintAddress, pending);
    
    logger.info(`[📝 PENDING-ADD] ${shortMint} | Added transaction to pending list: ${txHash.slice(0, 8)}... | Total: ${pending.length}`);
  }

  /**
   * Removes a pending transaction from the tracking map
   */
  private static removePendingTransaction(mintAddress: string, txHash: string): void {
    const shortMint = getTokenShortName(mintAddress);
    const pending = pendingTransactions.get(mintAddress) || [];
    
    const filtered = pending.filter(tx => tx.txHash !== txHash);
    pendingTransactions.set(mintAddress, filtered);
    
    if (pending.length !== filtered.length) {
      logger.info(`[📝 PENDING-REMOVE] ${shortMint} | Removed transaction from pending list: ${txHash.slice(0, 8)}... | Remaining: ${filtered.length}`);
    }
  }

  /**
   * Clean up expired pending transactions
   */
  private static cleanupExpiredTransactions(mintAddress: string): void {
    const pending = pendingTransactions.get(mintAddress) || [];
    const now = Date.now();
    
    // Use a fixed 5 minute expiration time
    const filtered = pending.filter(tx => now - tx.timestamp < 300000);
    
    if (filtered.length !== pending.length) {
      const shortMint = getTokenShortName(mintAddress);
      logger.info(`[🧹 CLEANUP] ${shortMint} | Removed ${pending.length - filtered.length} expired pending transactions`);
      pendingTransactions.set(mintAddress, filtered);
    }
  }

  /**
   * Subscribe to token program for changes related to this token
   */
  private static subscribeToTokenProgram(mintAddress: string): void {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      const mint = new PublicKey(mintAddress);
      
      const subscriptionId = connection.onProgramAccountChange(
        TOKEN_PROGRAM_ID,
        (accountInfo, context) => this.handleTokenProgramChange(mintAddress, accountInfo, context),
        'confirmed',
        [
          { memcmp: { offset: 0, bytes: mint.toBase58() } },
          { dataSize: 165 }
        ]
      );
      
      this.activeSubscriptions.set(mintAddress, subscriptionId);
      logger.info(`[🔌 CONNECTED] Token program subscription established for ${shortMint}`);
    } catch (error) {
      logger.error(`[❌ SUBSCRIBE-ERROR] Error subscribing to token program for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Find the liquidity pool associated with a token
   */
  private static async findLiquidityPoolForToken(mintAddress: string): Promise<{poolAddress?: PublicKey}> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      // Try to find pool in Raydium
      const poolId = await fetchPoolInfoByMint(mintAddress);
      if (poolId) {
        logger.info(`[🏊 POOL] Found Raydium pool for ${shortMint}: ${poolId.slice(0, 8)}...`);
        return { poolAddress: new PublicKey(poolId) };
      }
      
      // Try to find pool in Pump.fun
      const pumpData = await getPumpData(new PublicKey(mintAddress));
      if (pumpData && pumpData.bondingCurve) {
        logger.info(`[🏊 POOL] Found Pump.fun pool for ${shortMint}: ${pumpData.bondingCurve.toString().slice(0, 8)}...`);
        return { poolAddress: pumpData.bondingCurve };
      }
      
      logger.warn(`[⚠️ NO-POOL] Could not find liquidity pool for ${shortMint}`);
      return {};
    } catch (error) {
      logger.error(`[❌ POOL-ERROR] Error finding liquidity pool for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  /**
   * Handle changes in liquidity pool account
   */
  private static async handlePoolAccountChange(
    mintAddress: string, 
    accountInfo: AccountInfo<Buffer>, 
    context: Context
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      logger.info(`[⚡ EVENT] Detected pool change for token ${shortMint}, evaluating...`);
      
      // With direct evaluation:
      try {
        // REMOVED: Check for active lock - always proceed with evaluation
        
        // Clean up any expired transactions
        this.cleanupExpiredTransactions(mintAddress);
        
        // Get current token data and price
        const tokenData = await getTokenDataforAssets(mintAddress);
        const { price: currentPrice_usd } = await getPumpTokenPriceUSD(mintAddress);
        
        if (!currentPrice_usd || currentPrice_usd === 0) {
          logger.warn(`[⚠️ PRICE-WARNING] ${shortMint} | Could not get valid price, skipping evaluation`);
          return;
        }
        
        // Check if we should sell based on price changes
        await this.evaluateSellConditions(mintAddress, tokenData, currentPrice_usd);
      } catch (error) {
        logger.error(`[❌ POOL-EVENT-ERROR] Error in pool change handler for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      logger.error(`[❌ EVENT-ERROR] Error handling account change for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle token program changes
   */
  private static async handleTokenProgramChange(
    mintAddress: string,
    accountInfo: any,
    context: Context
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      logger.info(`[⚡ EVENT] Detected token program change for ${shortMint}, evaluating...`);
      
      try {
        // REMOVED: Check for active lock - always proceed with evaluation
        
        // Clean up any expired transactions
        this.cleanupExpiredTransactions(mintAddress);
        
        // Get current token data and price
        const tokenData = await getTokenDataforAssets(mintAddress);
        const { price: currentPrice_usd } = await getPumpTokenPriceUSD(mintAddress);
        
        if (!currentPrice_usd || currentPrice_usd === 0) {
          logger.warn(`[⚠️ PRICE-WARNING] ${shortMint} | Could not get valid price, skipping evaluation`);
          return;
        }
        
        await this.evaluateSellConditions(mintAddress, tokenData, currentPrice_usd);
      } catch (error) {
        logger.error(`[❌ TOKEN-EVENT-ERROR] Error in token program change handler for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      logger.error(`[❌ EVENT-ERROR] Error handling token program change for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Clean up oldest monitors to free memory
   */
  private static cleanupOldestMonitors(count: number): void {
    try {
      // Get tokens sorted by creation time (oldest first)
      const tokenEntries = Array.from(tokenCreatedTime.entries())
        .sort((a, b) => a[1] - b[1]);
      
      // Take the oldest 'count' tokens
      const tokensToRemove = tokenEntries.slice(0, count).map(entry => entry[0]);
      
      // Stop monitoring each token
      for (const mint of tokensToRemove) {
        const shortMint = getTokenShortName(mint);
        logger.info(`[🧹 MEMORY-CLEANUP] ${shortMint} | Stopping monitoring to free memory`);
        this.stopMonitoring(mint);
      }
    } catch (error) {
      logger.error(`[❌ CLEANUP-ERROR] Error cleaning up old monitors: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Evaluate if selling conditions are met
   */
  private static async evaluateSellConditions(
    mintAddress: string,
    tokenData: any,
    currentPrice_usd: number
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    const botSellConfig = SniperBotConfig.getSellConfig();
    
    try {
      // REMOVED: First check for active lock - always proceed with evaluation
      
      // REMOVED: Check for pending transactions - we want to sell aggressively now
      
      if (!tokenData || tokenData.currentAmount <= 0) {
        logger.info(`[🚫 ZERO] ${shortMint} | Current token amount is zero, stopping monitor`);
        this.stopMonitoring(mintAddress);
        return;
      }

      const curTokenAmount = await getTokenBalance(wallet.publicKey.toBase58(), mintAddress);
      if (curTokenAmount === 0) {
        logger.info(`[🚫 ZERO] ${shortMint} | Current token amount is zero, stopping monitor`);
        this.stopMonitoring(mintAddress);
        return;
      }

      // Use directly passed data if available, fall back to token data
      let investedPrice_usd = 0;
      
      // Try to get the invested price from direct data first
      const directData = tokenBuyTxInfo.get(mintAddress);
      if (directData && directData.swapPrice_usd) {
        investedPrice_usd = Number(directData.swapPrice_usd);
        logger.info(`[💾 USING-DIRECT-DATA] ${shortMint} | Using price from direct data: $${investedPrice_usd.toFixed(6)}`);
      } else {
        // Fall back to token data from assets service
        investedPrice_usd = tokenData.investedPrice_usd || 0;
        logger.info(`[💾 USING-ASSET-DATA] ${shortMint} | Using price from asset service: $${investedPrice_usd.toFixed(6)}`);
      }
      
      if (investedPrice_usd === 0) {
        logger.warn(`[❌ ERROR] No invested price found for ${shortMint}, skipping evaluation`);
        return;
      }
      
      // Calculate price change percentage
      const raisePercent = ((currentPrice_usd / investedPrice_usd) - 1) * 100;
      
      // PRIORITY 1: Check for price stagnation
      if (this.shouldSellDueToStagnation(mintAddress, currentPrice_usd)) {
        logger.info(`[💰 SELL-SIGNAL] ${shortMint} | Selling due to insufficient price growth | Price: $${currentPrice_usd.toFixed(6)} (${raisePercent > 0 ? "+" : ""}${raisePercent.toFixed(2)}%)`);
        
        try {
          const txResult = await sellTokenSwap(mintAddress, curTokenAmount, true, false);
          if (txResult) {
            // Add to pending transactions if valid hash returned
            if (typeof txResult === 'string') {
              this.addPendingTransaction(mintAddress, txResult, curTokenAmount, undefined, true);
              logger.info(`[🔄 PENDING] ${shortMint} | Stagnation sell transaction pending | TxHash: ${txResult.slice(0, 8)}...`);
            }
            
            logger.info(`[✅ SOLD] ${shortMint} | Sold due to insufficient price growth | Amount: ${curTokenAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)} | TxHash: ${typeof txResult === 'string' ? txResult.slice(0, 8) + '...' : 'N/A'}`);
            this.stopMonitoring(mintAddress);
            return;
          } else {
            logger.error(`[❌ SELL-ERROR] ${shortMint} | Failed to sell tokens due to insufficient growth`);
          }
        } catch (error) {
          logger.error(`[❌ SELL-ERROR] ${shortMint} | Error during price stagnation sell: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      
      // PRIORITY 2: Auto sell tokens if MC < $7K and age > 48h
      const now = Date.now();
      const createdTime = tokenCreatedTime.get(mintAddress) || 0;
      const mcUsd = currentPrice_usd * TOTAL_SUPPLY;
      
      if (mcUsd < 7000 && now - createdTime > 2 * 24 * 60 * 60 * 1000) {
        logger.info(`[💰 SELL-SIGNAL] ${shortMint} | Selling because MC < $7K and age > 48h | MC: $${mcUsd.toFixed(2)}`);
        
        try {
          const txResult = await sellTokenSwap(mintAddress, curTokenAmount, true, false);
          if (txResult) {
            // Add to pending transactions if valid hash returned
            if (typeof txResult === 'string') {
              this.addPendingTransaction(mintAddress, txResult, curTokenAmount);
              logger.info(`[🔄 PENDING] ${shortMint} | Low MC sell transaction pending | TxHash: ${txResult.slice(0, 8)}...`);
            }
            
            logger.info(`[✅ SOLD] ${shortMint} | Sold due to low MC and age | Amount: ${curTokenAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)} | TxHash: ${typeof txResult === 'string' ? txResult.slice(0, 8) + '...' : 'N/A'}`);
            this.stopMonitoring(mintAddress);
            return;
          } else {
            logger.error(`[❌ SELL-ERROR] ${shortMint} | Failed to sell tokens with low MC`);
          }
        } catch (error) {
          logger.error(`[❌ SELL-ERROR] ${shortMint} | Error during low MC sell: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      
      // PRIORITY 3: Check loss exit condition
      if (raisePercent < 0 && Math.abs(raisePercent) > botSellConfig.lossExitPercent) {
        logger.info(`[💰 SELL-SIGNAL] ${shortMint} | Price dropped below stop loss (${raisePercent.toFixed(2)}% < -${botSellConfig.lossExitPercent}%)`);
        
        try {
          const txResult = await sellTokenSwap(mintAddress, curTokenAmount, true, false);
          if (txResult) {
            // Add to pending transactions if valid hash returned
            if (typeof txResult === 'string') {
              this.addPendingTransaction(mintAddress, txResult, curTokenAmount);
              logger.info(`[🔄 PENDING] ${shortMint} | Stop loss sell transaction pending | TxHash: ${txResult.slice(0, 8)}...`);
            }
            
            logger.info(`[✅ SOLD] ${shortMint} | Sold due to stop loss | Amount: ${curTokenAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)} | TxHash: ${typeof txResult === 'string' ? txResult.slice(0, 8) + '...' : 'N/A'}`);
            this.stopMonitoring(mintAddress);
            return;
          } else {
            logger.error(`[❌ SELL-ERROR] ${shortMint} | Failed to sell on stop loss`);
          }
        } catch (error) {
          logger.error(`[❌ SELL-ERROR] ${shortMint} | Error during stop loss sell: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      
      // PRIORITY 4: Check progressive profit-taking
      const selling_step = tokenSellingStep.get(mintAddress) || 0;
      if (selling_step >= 4) {
        logger.info(`[🏁 COMPLETE] ${shortMint} | All sell steps completed (${selling_step}/4)`);
        this.stopMonitoring(mintAddress);
        return;
      }
      
      const sellRules = botSellConfig.saleRules;
      const sellSumPercent = sellRules.reduce((acc, rule) => acc + rule.percent, 0);
      
      // Check if we should proceed with a step sell
      for (let checkStep = selling_step; checkStep < 4; checkStep++) {
        const rule = sellRules[checkStep];
        
        if (raisePercent >= rule.revenue) {
          logger.info(`[💰 STEP-SELL] ${shortMint} | Step ${checkStep + 1}/4 | Target: ${rule.revenue.toFixed(2)}% | Current: ${raisePercent.toFixed(2)}% | Selling: ${rule.percent}%`);
          
          const sellPercent = rule.percent;
          
          // Get the invested amount from direct data if possible
          let investedAmount = 0;
          if (directData && directData.swapAmount) {
            investedAmount = Number(directData.swapAmount) * 10 ** TOKEN_DECIMALS;
            logger.info(`[💾 USING-DIRECT-AMOUNT] ${shortMint} | Using amount from direct data: ${directData.swapAmount}`);
          } else {
            investedAmount = tokenData.investedAmount * 10 ** TOKEN_DECIMALS;
            logger.info(`[💾 USING-ASSET-AMOUNT] ${shortMint} | Using amount from asset service: ${tokenData.investedAmount}`);
          }
          
          let sellAmount;
          if (checkStep === 3 && sellSumPercent === 100) {
            // Final step - sell all remaining
            sellAmount = curTokenAmount;
            logger.info(`[🔄 FINAL-SELL] ${shortMint} | Selling all remaining tokens: ${curTokenAmount / 10 ** TOKEN_DECIMALS}`);
          } else {
            // Partial sell according to the rule
            sellAmount = Math.min(
              Math.floor((investedAmount * sellPercent) / 100), 
              curTokenAmount
            );
            logger.info(`[🔄 PARTIAL-SELL] ${shortMint} | Selling ${sellAmount / 10 ** TOKEN_DECIMALS} tokens (${sellPercent}% of initial investment)`);
          }
          
          try {
            const txResult = await sellTokenSwap(
              mintAddress, 
              sellAmount, 
              checkStep === 3, 
              false
            );
            
            if (txResult) {
              // Add to pending transactions if valid hash returned
              if (typeof txResult === 'string') {
                this.addPendingTransaction(mintAddress, txResult, sellAmount, checkStep);
                logger.info(`[🔄 PENDING] ${shortMint} | Step ${checkStep + 1} sell transaction pending | TxHash: ${txResult.slice(0, 8)}...`);
              }
              
              logger.info(`[✅ STEP-SOLD] ${shortMint} | Successfully executed step ${checkStep + 1} sell | Amount: ${sellAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)} | TxHash: ${typeof txResult === 'string' ? txResult.slice(0, 8) + '...' : 'N/A'}`);
              
              tokenSellingStep.set(mintAddress, checkStep + 1);
              
              if (checkStep === 3) {
                this.stopMonitoring(mintAddress);
              }
            } else {
              logger.error(`[❌ SELL-ERROR] ${shortMint} | Failed to execute step ${checkStep + 1} sell`);
            }
          } catch (error) {
            logger.error(`[❌ SELL-ERROR] ${shortMint} | Error during step ${checkStep + 1} sell: ${error instanceof Error ? error.message : String(error)}`);
          }
          
          break; // Only execute one rule at a time
        }
      }
    } catch (error) {
      logger.error(`[❌ EVAL-ERROR] Error evaluating sell conditions for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Process a transaction confirmation
   */
  public static processTransactionConfirmation(mintAddress: string, txHash: string, success: boolean): void {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      // Find the pending transaction
      const pending = pendingTransactions.get(mintAddress) || [];
      const transaction = pending.find(tx => tx.txHash === txHash);
      
      if (!transaction) {
        logger.warn(`[⚠️ TX-WARNING] ${shortMint} | Transaction ${txHash.slice(0, 8)}... not found in pending list`);
        return;
      }
      
      if (success) {
        logger.info(`[✅ TX-CONFIRMED] ${shortMint} | Transaction ${txHash.slice(0, 8)}... confirmed successfully`);
        
        // Update selling step if it was a step sell
        if (transaction.sellStep !== undefined) {
          tokenSellingStep.set(mintAddress, transaction.sellStep + 1);
          logger.info(`[📊 STEP-UPDATE] ${shortMint} | Updated selling step to ${transaction.sellStep + 1}/4`);
        }
        
        // If it was a stagnation sell or final step, stop monitoring
        if (transaction.isStagnationSell || transaction.sellStep === 3) {
          this.stopMonitoring(mintAddress);
        }
      } else {
        logger.error(`[❌ TX-FAILED] ${shortMint} | Transaction ${txHash.slice(0, 8)}... failed`);
      }
      
      // Remove the transaction from pending list
      this.removePendingTransaction(mintAddress, txHash);
      
    } catch (error) {
      logger.error(`[❌ CONFIRM-ERROR] Error processing transaction confirmation for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stop monitoring a token
   */
  public static stopMonitoring(mintAddress: string): void {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      // Clear status logging interval
      if (statusLogIntervals.has(mintAddress)) {
        clearInterval(statusLogIntervals.get(mintAddress)!);
        statusLogIntervals.delete(mintAddress);
      }
      
      // Remove price data
      if (tokenPriceData.has(mintAddress)) {
        tokenPriceData.delete(mintAddress);
      }
      
      // Clear pending transactions
      pendingTransactions.delete(mintAddress);
      
      // Clear direct data
      tokenBuyTxInfo.delete(mintAddress);
      
      // Remove WebSocket subscription
      const subscriptionId = this.activeSubscriptions.get(mintAddress);
      if (subscriptionId !== undefined) {
        connection.removeAccountChangeListener(subscriptionId);
        this.activeSubscriptions.delete(mintAddress);
        this.monitoredTokens.delete(mintAddress);
        tokenSellingStep.delete(mintAddress);
        logger.info(`[🛑 STOPPED] Stopped monitoring token: ${shortMint}`);
      }
    } catch (error) {
      logger.error(`[❌ STOP-ERROR] Error stopping monitoring for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stop all monitoring
   */
  public static stopAllMonitoring(): void {
    try {
      // Clear all status logging intervals
      for (const [mintAddress, interval] of statusLogIntervals.entries()) {
        clearInterval(interval);
      }
      statusLogIntervals.clear();
      
      // Clear all price data
      tokenPriceData.clear();
      
      // Clear sync interval
      if (this.syncInterval) {
        clearInterval(this.syncInterval);
        this.syncInterval = null;
      }

      // Clear active monitoring interval
      if (this.activeMonitorInterval) {
        clearInterval(this.activeMonitorInterval);
        this.activeMonitorInterval = null;
      }
      
      // Clear memory monitor
      if (this.memoryMonitorInterval) {
        clearInterval(this.memoryMonitorInterval);
        this.memoryMonitorInterval = null;
      }
      
      // Clear all pending transactions
      pendingTransactions.clear();
      
      // Clear direct data
      tokenBuyTxInfo.clear();
      
      // Remove all WebSocket subscriptions
      for (const [mintAddress, subscriptionId] of this.activeSubscriptions.entries()) {
        const shortMint = getTokenShortName(mintAddress);
        connection.removeAccountChangeListener(subscriptionId);
        logger.info(`[🛑 STOPPED] Stopped monitoring token: ${shortMint}`);
      }
      
      this.activeSubscriptions.clear();
      this.monitoredTokens.clear();
      tokenSellingStep.clear();
      tokenCreatedTime.clear();
      
      logger.info("[🛑 SHUTDOWN] Stopped all WebSocket monitoring");
      this.isInitialized = false;
    } catch (error) {
      logger.error(`[❌ STOP-ERROR] Error stopping all monitoring: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}