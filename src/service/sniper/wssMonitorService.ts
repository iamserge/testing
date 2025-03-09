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
import { createAlert } from "../alarm/alarm";
import { PUMPFUN_IMG } from "../../utils/constants";
import { SwapParam, IAlertMsg } from "../../utils/types";
import { confirmVtxn } from "../swap/swap";
import { raydiumSwap } from "../swap/raydium/raydiumSwap";
import { pumpfunSwap } from "../swap/pumpfun/pumpfunSwap";

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

// Interface for prepared sell transactions
interface PreparedSellTransaction {
  transaction: VersionedTransaction;
  targetPrice: number;
  amount: number;
  preparedAt: number;
  valid: boolean; // Becomes false if conditions change
}

// Interface for cached price evaluations
interface PriceEvaluation {
  price: number;
  timestamp: number;
  evaluation: {
    shouldSellStagnation: boolean;
    shouldSellLoss: boolean;
    shouldSellProfit: boolean;
    stepToExecute?: number;
  };
}

// Maps for tracking token state
const tokenSellingStep: Map<string, number> = new Map();
const tokenCreatedTime: Map<string, number> = new Map();
const statusLogIntervals: Map<string, NodeJS.Timeout> = new Map();
const tokenPriceData: Map<string, PriceData> = new Map();
const pendingTransactions: Map<string, PendingTransaction[]> = new Map();

// New map to store direct buy transaction info (without DB lookups)
const tokenBuyTxInfo: Map<string, Partial<ITransaction>> = new Map();

// Performance optimization maps
const preparedSellTransactions: Map<string, PreparedSellTransaction> = new Map();
const priceEvaluationCache: Map<string, PriceEvaluation> = new Map();
const lastEvaluationTime: Map<string, number> = new Map();
const lastEvaluatedPrice: Map<string, number> = new Map();

// Constants for performance tuning
const MIN_EVALUATION_INTERVAL = 300; // Minimum ms between evaluations
const PRICE_CACHE_TTL = 1000; // Price cache time-to-live in ms
const PREPARED_TX_TTL = 60000; // Prepared transaction time-to-live in ms
const PERFORMANCE_LOG_INTERVAL = 5 * 60 * 1000; // Log performance metrics every 5 minutes

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

// Helper function to format numbers for display
function formatNumber(num: number, decimals: number = 6): string {
  return num.toFixed(decimals);
}

export class WssMonitorService {
  private static monitoredTokens: Map<string, PublicKey> = new Map();
  private static activeSubscriptions: Map<string, number> = new Map();
  public static isInitialized: boolean = false;
  private static syncInterval: NodeJS.Timeout | null = null;
  private static activeMonitorInterval: NodeJS.Timeout | null = null;
  private static memoryMonitorInterval: NodeJS.Timeout | null = null;
  private static performanceLogInterval: NodeJS.Timeout | null = null;
  
  // Performance metrics
  private static totalEvaluations: number = 0;
  private static successfulSells: number = 0;
  private static failedSells: number = 0;
  private static preparedTransactionsUsed: number = 0;
  private static preparedTransactionsFailed: number = 0;

  /**
   * Initialize the WebSocket monitoring service
   */
  public static initialize(): void {
    if (this.isInitialized) return;
    
    logger.info(`${START_TXT.sell} ✨ WebSocket-based Sell monitor service started at ${new Date().toISOString()}`);
    this.isInitialized = true;
    
    // Initialize maps
    pendingTransactions.clear();
    tokenBuyTxInfo.clear();
    priceEvaluationCache.clear();
    preparedSellTransactions.clear();
    
    // Initial sync of monitored tokens
    this.syncMonitoredTokens();
    
    // Set up periodic sync to ensure we're monitoring all wallet tokens
    this.syncInterval = setInterval(() => this.syncMonitoredTokens(), 30000); // Check every 30 seconds
    
    // Set up active price monitoring every 1 second
    this.startActiveMonitoring();

    // Memory monitoring every 5 minutes
    this.memoryMonitorInterval = setInterval(() => {
      try {
        const activeTokenCount = this.monitoredTokens.size;
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024 * 100) / 100;
        
        logger.info(`[🧠 MEMORY] Active tokens: ${activeTokenCount} | Heap used: ${heapUsedMB}MB`);
        
        // If memory usage is high, force cleanup of older monitoring operations
        if (heapUsedMB > 500) { // 500MB threshold
          logger.warn(`[⚠️ HIGH-MEMORY] Initiating cleanup of older token monitors`);
          this.cleanupOldestMonitors(5); // Remove 5 oldest monitors
        }
        
        // Cleanup expired prepared transactions
        this.cleanupExpiredPreparedTransactions();
      } catch (error) {
        logger.error(`[❌ MEMORY-ERROR] Error monitoring memory: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 300000); // Every 5 minutes
    
    // Log performance metrics
    this.performanceLogInterval = setInterval(() => {
      const totalMonitored = this.monitoredTokens.size;
      const preparedTxCount = preparedSellTransactions.size;
      const cachedEvalCount = priceEvaluationCache.size;
      
      logger.info(`[📊 PERFORMANCE] Tokens monitored: ${totalMonitored} | Total evaluations: ${this.totalEvaluations}`);
      logger.info(`[📊 PERFORMANCE] Successful sells: ${this.successfulSells} | Failed sells: ${this.failedSells}`);
      logger.info(`[📊 PERFORMANCE] Prepared transactions: ${preparedTxCount} | Used: ${this.preparedTransactionsUsed} | Failed: ${this.preparedTransactionsFailed}`);
      logger.info(`[📊 PERFORMANCE] Cached evaluations: ${cachedEvalCount}`);
    }, PERFORMANCE_LOG_INTERVAL);
  }

  /**
   * Start active monitoring to check token prices more frequently
   */
  private static startActiveMonitoring(): void {
    if (this.activeMonitorInterval) {
      clearInterval(this.activeMonitorInterval);
    }
    
    logger.info(`[⏱️ ACTIVE-MONITOR] Starting frequent price checks every 1 second`);
    
    this.activeMonitorInterval = setInterval(async () => {
      try {
        // Check all monitored tokens
        for (const [mintAddress, _] of this.monitoredTokens) {
          const shortMint = getTokenShortName(mintAddress);
          
          try {
            // Direct evaluation without queuing
            try {
              const tokenData = await getTokenDataforAssets(mintAddress);
              if (!tokenData) continue;
              
              const { price: currentPrice_usd } = await getPumpTokenPriceUSD(mintAddress);
              
              if (currentPrice_usd > 0) {
                // Check if this token needs evaluation
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
    }, 1000); // Check every 1 second
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
   * Enhanced to support preliminary monitoring before confirmation
   */
  public static async startMonitoringWithData(
    mintAddress: string, 
    buyTxInfo: Partial<ITransaction>,
    isPreliminary: boolean = false
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      if (isPreliminary) {
        logger.info(`[🔍 PRELIMINARY-MONITOR] ${shortMint} | Starting early monitoring before confirmation`);
      }
      
      // Store the buy transaction info directly in memory
      tokenBuyTxInfo.set(mintAddress, buyTxInfo);
      
      // Set creation time to now if not already set
      if (!tokenCreatedTime.has(mintAddress)) {
        tokenCreatedTime.set(mintAddress, buyTxInfo.txTime || Date.now());
      }
      
      // Initialize selling step to 0 (first purchase)
      tokenSellingStep.set(mintAddress, 0);
      
      // Start price monitoring in parallel (don't await for immediate return)
      this.initializeDirectTokenMonitoring(mintAddress, isPreliminary)
        .catch(error => {
          logger.error(`[❌ MONITOR-ERROR] ${shortMint} | Initialization error: ${error instanceof Error ? error.message : String(error)}`);
        });
      
      // If preliminary, return immediately without full initialization
      if (isPreliminary) {
        return;
      }
      
      // For confirmed transactions, continue with full monitoring setup
      await this.startMonitoringWithDirectData(mintAddress);
    } catch (error) {
      logger.error(`[❌ DIRECT-MONITOR-ERROR] ${shortMint} | Error starting monitoring: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  
  /**
   * Update monitoring data after transaction confirmation
   */
  public static updateMonitoringData(
    mintAddress: string, 
    updatedBuyTxInfo: Partial<ITransaction>
  ): void {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      // Update the stored transaction info
      const existingInfo = tokenBuyTxInfo.get(mintAddress);
      if (existingInfo) {
        tokenBuyTxInfo.set(mintAddress, {
          ...existingInfo,
          ...updatedBuyTxInfo
        });
        
        logger.info(`[🔄 MONITOR-UPDATE] ${shortMint} | Updated monitoring data with confirmed values`);
      } else {
        logger.warn(`[⚠️ MONITOR-WARNING] ${shortMint} | No existing monitoring data to update`);
        tokenBuyTxInfo.set(mintAddress, updatedBuyTxInfo);
      }
      
      // Invalidate any cached price evaluations
      priceEvaluationCache.delete(mintAddress);
      
      // Begin preparing potential sell transactions
      this.preparePotentialSellTransactions(mintAddress).catch(error => {
        logger.error(`[❌ PREPARE-ERROR] ${shortMint} | Error preparing sell transactions: ${error.message}`);
      });
    } catch (error) {
      logger.error(`[❌ UPDATE-ERROR] ${shortMint} | Error updating monitoring data: ${error instanceof Error ? error.message : String(error)}`);
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
   * Initialize token monitoring with optimized parallel operations
   */
  private static async initializeDirectTokenMonitoring(
    mintAddress: string,
    isPreliminary: boolean = false
  ): Promise<void> {
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
      
      // Fetch current price in parallel
      getPumpTokenPriceUSD(mintAddress).then(({ price: initialPrice_usd }) => {
        try {
          const botSellConfig = SniperBotConfig.getSellConfig();
          const durationSec = typeof botSellConfig.mcChange?.duration === 'number' ? 
            (botSellConfig.mcChange.duration > 1000 ? botSellConfig.mcChange.duration / 1000 : botSellConfig.mcChange.duration) : 
            10;
          
          const percentValue = typeof botSellConfig.mcChange?.percentValue === 'number' ? 
            botSellConfig.mcChange.percentValue : 25;
          
          // Create price data for monitoring
          const priceData: PriceData = {
            initialPrice: initialPrice_usd,
            threshold: percentValue / 100,
            duration: durationSec * 1000,
            startTime: Date.now()
          };
          
          // Store the price data in the map
          tokenPriceData.set(mintAddress, priceData);
          
          const initTimeMs = Date.now() - startTime;
          
          if (!isPreliminary) {
            logger.info(`[🔄 PRICE-MONITOR] ${shortMint} | Created with initial price $${initialPrice_usd.toFixed(6)}, threshold ${percentValue}%, duration ${durationSec}s | Init time: ${initTimeMs}ms`);
          
            // Begin preparing potential sell transactions
            this.preparePotentialSellTransactions(mintAddress).catch(error => {
              logger.error(`[❌ PREPARE-ERROR] ${shortMint} | Error preparing sell transactions: ${error.message}`);
            });
          } else {
            logger.info(`[🔄 PRELIMINARY-PRICE] ${shortMint} | Preliminary monitoring with price $${initialPrice_usd.toFixed(6)}`);
          }
        } catch (priceError) {
          logger.error(`[❌ PRICE-ERROR] Failed to initialize price monitoring for ${shortMint}: ${priceError instanceof Error ? priceError.message : String(priceError)}`);
        }
      }).catch(error => {
        logger.error(`[❌ PRICE-ERROR] ${shortMint} | Error getting initial price: ${error instanceof Error ? error.message : String(error)}`);
      });
      
      // Set up periodic status logging if not preliminary
      if (!isPreliminary) {
        this.setupStatusLogging(mintAddress, buyTx.txTime || Date.now(), investedPrice_usd);
      }
      
      const initTimeMs = Date.now() - startTime;
      
      if (!isPreliminary) {
        logger.info(`[📊 INFO] ${shortMint} | Monitoring initialized in ${initTimeMs}ms | Buy Price: $${investedPrice_usd.toFixed(6)}`);
      } else {
        logger.info(`[📊 PRELIMINARY-INFO] ${shortMint} | Preliminary monitoring initialized in ${initTimeMs}ms`);
      }
    } catch (error) {
      logger.error(`[❌ DIRECT-INIT-ERROR] Error initializing token data for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
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
        
        // Begin preparing potential sell transactions
        this.preparePotentialSellTransactions(mintAddress).catch(error => {
          logger.error(`[❌ PREPARE-ERROR] ${shortMint} | Error preparing sell transactions: ${error.message}`);
        });
      } catch (priceError) {
        logger.error(`[❌ PRICE-ERROR] Failed to initialize price monitoring for ${shortMint}: ${priceError instanceof Error ? priceError.message : String(priceError)}`);
      }
  
      // Set up periodic status logging
      this.setupStatusLogging(mintAddress, buyTx.txTime, investedPrice_usd);
      
    } catch (error) {
      logger.error(`[❌ DB-INIT-ERROR] Error initializing token data from database for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Prepare potential sell transactions in advance
   */
  private static async preparePotentialSellTransactions(mintAddress: string): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      // Get buy transaction data
      const directData = tokenBuyTxInfo.get(mintAddress);
      let investedPrice_usd = 0;
      let investedAmount = 0;
      
      if (directData && directData.swapPrice_usd) {
        investedPrice_usd = Number(directData.swapPrice_usd);
        investedAmount = Number(directData.swapAmount || 0) * 10 ** TOKEN_DECIMALS;
      } else {
        // Try to get from database if direct data is unavailable
        const tokenData = await getTokenDataforAssets(mintAddress);
        if (tokenData) {
          investedPrice_usd = tokenData.investedPrice_usd || 0;
          investedAmount = (tokenData.investedAmount || 0) * 10 ** TOKEN_DECIMALS;
        }
      }
      
      if (!investedPrice_usd || !investedAmount) {
        logger.warn(`[⚠️ PREPARE-WARNING] ${shortMint} | Missing investment data, cannot prepare transactions`);
        return;
      }
      
      // Calculate profit targets
      const sellRules = SniperBotConfig.getSellConfig().saleRules;
      const stopLossPercent = SniperBotConfig.getSellConfig().lossExitPercent;
      
      // Get current token balance
      const tokenBalance = await getTokenBalance(wallet.publicKey.toBase58(), mintAddress);
      if (tokenBalance <= 0) {
        logger.warn(`[⚠️ PREPARE-WARNING] ${shortMint} | No token balance, skipping transaction preparation`);
        return;
      }
      
      // Prepare stop loss transaction
      const stopLossPrice = investedPrice_usd * (1 - stopLossPercent / 100);
      logger.info(`[🔄 PREPARE-LOSS] ${shortMint} | Preparing stop loss transaction at $${stopLossPrice.toFixed(6)}`);
      
      const lossSwapParam: SwapParam = {
        mint: mintAddress,
        amount: tokenBalance,
        tip: SniperBotConfig.getBuyConfig().jitoTipAmount,
        slippage: SniperBotConfig.getBuyConfig().slippage * 1.5, // Higher slippage for emergency
        is_buy: false,
        isSellAll: false
      };
      
      // Prepare stop loss transaction in background
      this.prepareAndCacheTransaction(mintAddress, lossSwapParam, stopLossPrice, tokenBalance, "loss");
      
      // Prepare transactions for profit targets
      for (let i = 0; i < sellRules.length; i++) {
        const rule = sellRules[i];
        const targetPrice = investedPrice_usd * (1 + rule.revenue / 100);
        
        // Calculate sell amount based on percentage
        const sellPercent = rule.percent;
        const sellAmount = Math.min(
          Math.floor((investedAmount * sellPercent) / 100),
          tokenBalance
        );
        
        if (sellAmount > 0) {
          const profitSwapParam: SwapParam = {
            mint: mintAddress,
            amount: sellAmount,
            tip: SniperBotConfig.getBuyConfig().jitoTipAmount,
            slippage: SniperBotConfig.getBuyConfig().slippage,
            is_buy: false,
            isSellAll: i === sellRules.length - 1 && rule.percent >= 90
          };
          
          logger.info(`[🔄 PREPARE-PROFIT] ${shortMint} | Preparing profit transaction for step ${i+1} at $${targetPrice.toFixed(6)}`);
          this.prepareAndCacheTransaction(mintAddress, profitSwapParam, targetPrice, sellAmount, `profit-${i}`);
        }
      }
    } catch (error) {
      logger.error(`[❌ PREPARE-ERROR] ${shortMint} | Error preparing sell transactions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Prepare and cache transaction for later use
   */
  private static async prepareAndCacheTransaction(
    mintAddress: string,
    swapParam: SwapParam,
    targetPrice: number,
    amount: number,
    type: string
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      // Create swap response without sending
      let swapResponse;
      
      // Try pumpfun first
      const { pumpData } = await getPumpTokenPriceUSD(mintAddress);
      if (pumpData) {
        // Add pump data to swap parameters
        swapParam.pumpData = pumpData;
        swapParam.isPumpfun = true;
        
        swapResponse = await pumpfunSwap(swapParam);
      }
      
      // If pumpfun fails, try raydium
      if (!swapResponse) {
        swapResponse = await raydiumSwap(swapParam);
      }
      
      if (swapResponse) {
        // Sign the transaction
        const vTxn = swapResponse.vTxn;
        vTxn.sign([wallet]);
        
        // Store the prepared transaction
        preparedSellTransactions.set(`${mintAddress}-${type}`, {
          transaction: vTxn,
          targetPrice,
          amount,
          preparedAt: Date.now(),
          valid: true
        });
        
        logger.info(`[✅ PREPARED-${type.toUpperCase()}] ${shortMint} | Prepared sell transaction for $${targetPrice.toFixed(6)}`);
      } else {
        logger.warn(`[⚠️ PREPARE-FAILED] ${shortMint} | Failed to prepare ${type} transaction`);
      }
    } catch (error) {
      logger.error(`[❌ PREPARE-ERROR] ${shortMint} | Error preparing ${type} transaction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Clean up expired prepared transactions
   */
  private static cleanupExpiredPreparedTransactions(): void {
    const now = Date.now();
    let expiredCount = 0;
    
    for (const [key, tx] of preparedSellTransactions.entries()) {
      if (now - tx.preparedAt > PREPARED_TX_TTL) {
        preparedSellTransactions.delete(key);
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      logger.info(`[🧹 CLEANUP] Removed ${expiredCount} expired prepared transactions`);
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
    
    // Log progress if we're over 70% of the way there
    if (elapsedTime > priceData.duration * 0.7 && elapsedTime % 5000 < 1000) { // Log every ~5 seconds in the final stage
      const priceChange = (currentPrice - priceData.initialPrice) / priceData.initialPrice;
      const priceChangePercent = priceChange * 100;
      const minRequiredPercent = priceData.threshold * 100;
      const percentComplete = (elapsedTime / priceData.duration) * 100;
      
      logger.info(`[⏳ APPROACHING] ${shortMint} | Progress: ${percentComplete.toFixed(1)}% | Current Growth: ${priceChangePercent.toFixed(2)}% | Required: ${minRequiredPercent.toFixed(2)}%`);
    }
    
    return false;
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
        const priceData = tokenPriceData.get(mintAddress);
        if (priceData) {
          const elapsed = Date.now() - priceData.startTime;
          const elapsedPercent = Math.min(100, (elapsed / priceData.duration) * 100);
          const remaining = Math.max(0, priceData.duration - elapsed);
          const remainingTimeSeconds = Math.floor(remaining / 1000);
          
          logger.info(`[⏱️ GROWTH-MONITOR] ${shortMint} | Progress: ${elapsedPercent.toFixed(1)}% | Remaining: ${formatTimeElapsed(remaining)} | Required Growth: ${(priceData.threshold * 100).toFixed(2)}%`);
        }
      } catch (error) {
        logger.error(`[❌ STATUS-ERROR] Error logging status for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 60000); // Every 60 seconds
    
    statusLogIntervals.set(mintAddress, interval);
  }

  /**
   * Adds a pending transaction to the tracking map
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
      
      try {
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
   * Enhanced evaluation of sell conditions with optimizations
   */
  private static async evaluateSellConditions(
    mintAddress: string,
    tokenData: any,
    currentPrice_usd: number
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    const now = Date.now();
    
    try {
      // Count this evaluation
      this.totalEvaluations++;
      
      // Check if token has zero balance
      if (!tokenData || tokenData.currentAmount <= 0) {
        logger.info(`[🚫 ZERO] ${shortMint} | Current token amount is zero, stopping monitor`);
        this.stopMonitoring(mintAddress);
        return;
      }
      
      // Throttle evaluation frequency
      const lastEval = lastEvaluationTime.get(mintAddress) || 0;
      const lastPrice = lastEvaluatedPrice.get(mintAddress) || 0;
      
      // Skip frequent evaluations unless there's significant price movement
      if (now - lastEval < MIN_EVALUATION_INTERVAL) {
        const priceChangePercent = Math.abs((currentPrice_usd - lastPrice) / lastPrice * 100);
        
        // Only process frequent evaluations if price changed significantly
        if (priceChangePercent < 1) {
          return;
        }
      }
      
      // Update tracking values
      lastEvaluationTime.set(mintAddress, now);
      lastEvaluatedPrice.set(mintAddress, currentPrice_usd);
      
      // Check if we have a cached evaluation that's still valid
      const cachedEval = priceEvaluationCache.get(mintAddress);
      if (cachedEval && now - cachedEval.timestamp < PRICE_CACHE_TTL) {
        // If price hasn't changed significantly, use cached evaluation
        const priceDiffPercent = Math.abs((currentPrice_usd - cachedEval.price) / cachedEval.price * 100);
        if (priceDiffPercent < 0.5) {
          const evaluation = cachedEval.evaluation;
          
          // Execute the cached evaluation result
          if (evaluation.shouldSellStagnation) {
            await this.executeSellForStagnation(mintAddress, currentPrice_usd);
            return;
          } else if (evaluation.shouldSellLoss) {
            await this.executeSellForLoss(mintAddress, currentPrice_usd);
            return;
          } else if (evaluation.shouldSellProfit && evaluation.stepToExecute !== undefined) {
            await this.executeSellForProfit(mintAddress, currentPrice_usd, evaluation.stepToExecute);
            return;
          }
          
          // Cache was valid but no sell condition met
          return;
        }
      }
      
      // Get current token balance to verify
      const curTokenAmount = await getTokenBalance(wallet.publicKey.toBase58(), mintAddress);
      if (curTokenAmount === 0) {
        logger.info(`[🚫 ZERO-BALANCE] ${shortMint} | Token balance is zero, stopping monitor`);
        this.stopMonitoring(mintAddress);
        return;
      }
      
      // Use directly passed data if available, fall back to token data
      let investedPrice_usd = 0;
      
      // Try to get the invested price from direct data first
      const directData = tokenBuyTxInfo.get(mintAddress);
      if (directData && directData.swapPrice_usd) {
        investedPrice_usd = Number(directData.swapPrice_usd);
      } else {
        // Fall back to token data
        investedPrice_usd = tokenData.investedPrice_usd || 0;
      }
      
      if (investedPrice_usd === 0) {
        logger.warn(`[❌ ERROR] No invested price found for ${shortMint}, skipping evaluation`);
        return;
      }
      
      // Calculate price change percentage
      const raisePercent = ((currentPrice_usd / investedPrice_usd) - 1) * 100;
      
      // Prepare evaluation result object
      const evaluation = {
        shouldSellStagnation: false,
        shouldSellLoss: false,
        shouldSellProfit: false,
        stepToExecute: undefined as number | undefined
      };
      
      // PRIORITY 1: Check for price stagnation
      evaluation.shouldSellStagnation = this.shouldSellDueToStagnation(mintAddress, currentPrice_usd);
      if (evaluation.shouldSellStagnation) {
        // Cache the evaluation
        priceEvaluationCache.set(mintAddress, {
          price: currentPrice_usd,
          timestamp: now,
          evaluation
        });
        
        await this.executeSellForStagnation(mintAddress, currentPrice_usd);
        return;
      }
      
      // PRIORITY 2: Check for low market cap and old age
      const botSellConfig = SniperBotConfig.getSellConfig();
      const createdTime = tokenCreatedTime.get(mintAddress) || 0;
      const mcUsd = currentPrice_usd * TOTAL_SUPPLY;
      const isOldLowMcToken = mcUsd < 7000 && now - createdTime > 2 * 24 * 60 * 60 * 1000;
      
      if (isOldLowMcToken) {
        evaluation.shouldSellLoss = true;
        
        // Cache the evaluation
        priceEvaluationCache.set(mintAddress, {
          price: currentPrice_usd,
          timestamp: now,
          evaluation
        });
        
        await this.executeSellForLoss(mintAddress, currentPrice_usd);
        return;
      }
      
      // PRIORITY 3: Check loss exit condition
      if (raisePercent < 0 && Math.abs(raisePercent) > botSellConfig.lossExitPercent) {
        evaluation.shouldSellLoss = true;
        
        // Cache the evaluation
        priceEvaluationCache.set(mintAddress, {
          price: currentPrice_usd,
          timestamp: now,
          evaluation
        });
        
        await this.executeSellForLoss(mintAddress, currentPrice_usd);
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
      
      // Check if we should proceed with a step sell
      for (let checkStep = selling_step; checkStep < 4; checkStep++) {
        const rule = sellRules[checkStep];
        
        if (raisePercent >= rule.revenue) {
          evaluation.shouldSellProfit = true;
          evaluation.stepToExecute = checkStep;
          
          // Cache the evaluation
          priceEvaluationCache.set(mintAddress, {
            price: currentPrice_usd,
            timestamp: now,
            evaluation
          });
          
          await this.executeSellForProfit(mintAddress, currentPrice_usd, checkStep);
          return;
        }
      }
      
      // If we get here, no sell condition was met
      // Still cache the evaluation for future reference
      priceEvaluationCache.set(mintAddress, {
        price: currentPrice_usd,
        timestamp: now,
        evaluation
      });
    } catch (error) {
      logger.error(`[❌ EVAL-ERROR] Error evaluating sell conditions for ${shortMint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Execute sell for price stagnation
   */
  private static async executeSellForStagnation(
    mintAddress: string,
    currentPrice_usd: number
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      logger.info(`[💰 SELL-SIGNAL] ${shortMint} | Selling due to insufficient price growth | Price: $${currentPrice_usd.toFixed(6)}`);
      
      // Check if we have a prepared transaction
      const preparedTx = preparedSellTransactions.get(`${mintAddress}-loss`);
      
      if (preparedTx && preparedTx.valid && Date.now() - preparedTx.preparedAt < PREPARED_TX_TTL) {
        // Use the prepared transaction
        logger.info(`[⚡ FAST-EXECUTION] ${shortMint} | Using prepared transaction`);
        
        // Confirm the transaction
        const result = await confirmVtxn(preparedTx.transaction, mintAddress);
        
        if (result) {
          this.preparedTransactionsUsed++;
          logger.info(`[✅ SOLD] ${shortMint} | Sold due to insufficient price growth | Price: $${currentPrice_usd.toFixed(6)} | TxHash: ${result.txHash.slice(0, 8)}...`);
          this.successfulSells++;
          this.stopMonitoring(mintAddress);
        } else {
          this.preparedTransactionsFailed++;
          logger.error(`[❌ PREPARED-TX-FAILED] ${shortMint} | Prepared transaction failed, falling back to regular sell`);
          
          // If prepared transaction fails, fall back to regular sell
          const curTokenAmount = await getTokenBalance(wallet.publicKey.toBase58(), mintAddress);
          const txResult = await sellTokenSwap(mintAddress, curTokenAmount, true, false);
          
          if (txResult) {
            logger.info(`[✅ SOLD] ${shortMint} | Sold due to insufficient price growth | Amount: ${curTokenAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)}`);
            this.successfulSells++;
            this.stopMonitoring(mintAddress);
          } else {
            this.failedSells++;
            logger.error(`[❌ SELL-ERROR] ${shortMint} | Failed to sell tokens due to insufficient growth`);
          }
        }
      } else {
        // No valid prepared transaction, use regular sell
        const curTokenAmount = await getTokenBalance(wallet.publicKey.toBase58(), mintAddress);
        const txResult = await sellTokenSwap(mintAddress, curTokenAmount, true, false);
        
        if (txResult) {
          logger.info(`[✅ SOLD] ${shortMint} | Sold due to insufficient price growth | Amount: ${curTokenAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)}`);
          this.successfulSells++;
          this.stopMonitoring(mintAddress);
        } else {
          this.failedSells++;
          logger.error(`[❌ SELL-ERROR] ${shortMint} | Failed to sell tokens due to insufficient growth`);
        }
      }
    } catch (error) {
      this.failedSells++;
      logger.error(`[❌ SELL-ERROR] ${shortMint} | Error during stagnation sell: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Execute sell for stop loss
   */
  private static async executeSellForLoss(
    mintAddress: string,
    currentPrice_usd: number
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    
    try {
      logger.info(`[💰 SELL-SIGNAL] ${shortMint} | Selling due to stop loss | Price: $${currentPrice_usd.toFixed(6)}`);
      
      // Check if we have a prepared transaction
      const preparedTx = preparedSellTransactions.get(`${mintAddress}-loss`);
      
      if (preparedTx && preparedTx.valid && Date.now() - preparedTx.preparedAt < PREPARED_TX_TTL) {
        // Use the prepared transaction for faster execution
        logger.info(`[⚡ FAST-EXECUTION] ${shortMint} | Using prepared stop loss transaction`);
        
        // Confirm the transaction
        const result = await confirmVtxn(preparedTx.transaction, mintAddress);
        
        if (result) {
          this.preparedTransactionsUsed++;
          logger.info(`[✅ SOLD] ${shortMint} | Sold due to stop loss | Price: $${currentPrice_usd.toFixed(6)} | TxHash: ${result.txHash.slice(0, 8)}...`);
          this.successfulSells++;
          this.stopMonitoring(mintAddress);
          
          // Create alert for stop loss
          this.createStopLossAlert(mintAddress, currentPrice_usd);
        } else {
          this.preparedTransactionsFailed++;
          logger.error(`[❌ PREPARED-TX-FAILED] ${shortMint} | Prepared transaction failed, falling back to regular sell`);
          
          // If prepared transaction fails, fall back to regular sell
          const curTokenAmount = await getTokenBalance(wallet.publicKey.toBase58(), mintAddress);
          const txResult = await sellTokenSwap(mintAddress, curTokenAmount, true, false);
          
          if (txResult) {
            logger.info(`[✅ SOLD] ${shortMint} | Sold due to stop loss | Amount: ${curTokenAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)}`);
            this.successfulSells++;
            this.stopMonitoring(mintAddress);
            
            // Create alert for stop loss
            this.createStopLossAlert(mintAddress, currentPrice_usd);
          } else {
            this.failedSells++;
            logger.error(`[❌ SELL-ERROR] ${shortMint} | Failed to sell on stop loss`);
          }
        }
      } else {
        // No valid prepared transaction, use regular sell
        const curTokenAmount = await getTokenBalance(wallet.publicKey.toBase58(), mintAddress);
        const txResult = await sellTokenSwap(mintAddress, curTokenAmount, true, false);
        
        if (txResult) {
          logger.info(`[✅ SOLD] ${shortMint} | Sold due to stop loss | Amount: ${curTokenAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)}`);
          this.successfulSells++;
          this.stopMonitoring(mintAddress);
          
          // Create alert for stop loss
          this.createStopLossAlert(mintAddress, currentPrice_usd);
        } else {
          this.failedSells++;
          logger.error(`[❌ SELL-ERROR] ${shortMint} | Failed to sell on stop loss`);
        }
      }
    } catch (error) {
      this.failedSells++;
      logger.error(`[❌ SELL-ERROR] ${shortMint} | Error during stop loss sell: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Create alert for stop loss
   */
  private static async createStopLossAlert(mintAddress: string, price: number): Promise<void> {
    try {
      const tokenData = await getTokenDataforAssets(mintAddress);
      
      if (!tokenData) return;
      
      const alertData: IAlertMsg = {
        imageUrl: tokenData.tokenImage || PUMPFUN_IMG,
        title: `Stop Loss Triggered: ${tokenData.tokenSymbol || 'Unknown'}`,
        content: `🚨 Stop loss triggered for ${tokenData.tokenName || mintAddress} at $${price.toFixed(6)}. Token sold to protect investment.`,
        link: mintAddress,
        time: Date.now(),
        isRead: false,
      };
      
      await createAlert(alertData);
    } catch (error) {
      logger.error(`[❌ ALERT-ERROR] Error creating stop loss alert: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Execute sell for profit taking
   */
  private static async executeSellForProfit(
    mintAddress: string,
    currentPrice_usd: number,
    stepIndex: number
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    const botSellConfig = SniperBotConfig.getSellConfig();
    const sellRules = botSellConfig.saleRules;
    const rule = sellRules[stepIndex];
    
    try {
      logger.info(`[💰 STEP-SELL] ${shortMint} | Step ${stepIndex + 1}/4 | Target: ${rule.revenue.toFixed(2)}% | Selling: ${rule.percent}%`);
      
      // Check if we have a prepared transaction
      const preparedTx = preparedSellTransactions.get(`${mintAddress}-profit-${stepIndex}`);
      
      if (preparedTx && preparedTx.valid && Date.now() - preparedTx.preparedAt < PREPARED_TX_TTL) {
        // Use the prepared transaction for faster execution
        logger.info(`[⚡ FAST-EXECUTION] ${shortMint} | Using prepared profit transaction for step ${stepIndex + 1}`);
        
        // Confirm the transaction
        const result = await confirmVtxn(preparedTx.transaction, mintAddress);
        
        if (result) {
          this.preparedTransactionsUsed++;
          logger.info(`[✅ STEP-SOLD] ${shortMint} | Successfully executed step ${stepIndex + 1} sell | Price: $${currentPrice_usd.toFixed(6)} | TxHash: ${result.txHash.slice(0, 8)}...`);
          
          tokenSellingStep.set(mintAddress, stepIndex + 1);
          this.successfulSells++;
          
          if (stepIndex === 3) {
            this.stopMonitoring(mintAddress);
          } else {
            // Prepare next step transaction
            this.preparePotentialSellTransactions(mintAddress).catch(error => {
              logger.error(`[❌ PREPARE-ERROR] ${shortMint} | Error preparing next steps: ${error.message}`);
            });
          }
        } else {
          this.preparedTransactionsFailed++;
          // Fall back to regular sell
          await this.executeFallbackProfitSell(mintAddress, currentPrice_usd, stepIndex, rule);
        }
      } else {
        // No valid prepared transaction, use regular sell
        await this.executeFallbackProfitSell(mintAddress, currentPrice_usd, stepIndex, rule);
      }
    } catch (error) {
      this.failedSells++;
      logger.error(`[❌ SELL-ERROR] ${shortMint} | Error during profit sell step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Fallback profit sell execution when prepared transaction is invalid
   */
  private static async executeFallbackProfitSell(
    mintAddress: string,
    currentPrice_usd: number,
    stepIndex: number,
    rule: any
  ): Promise<void> {
    const shortMint = getTokenShortName(mintAddress);
    const sellPercent = rule.percent;
    const sellRules = SniperBotConfig.getSellConfig().saleRules;
    const sellSumPercent = sellRules.reduce((acc, r) => acc + r.percent, 0);
    
    try {
      // Get current token balance
      const curTokenAmount = await getTokenBalance(wallet.publicKey.toBase58(), mintAddress);
      
      // Get the invested amount from direct data if possible
      let investedAmount = 0;
      const directData = tokenBuyTxInfo.get(mintAddress);
      
      if (directData && directData.swapAmount) {
        investedAmount = Number(directData.swapAmount) * 10 ** TOKEN_DECIMALS;
      } else {
        // Fall back to getting from token data
        const tokenData = await getTokenDataforAssets(mintAddress);
        investedAmount = (tokenData?.investedAmount || 0) * 10 ** TOKEN_DECIMALS;
      }
      
      let sellAmount;
      if (stepIndex === 3 && sellSumPercent === 100) {
        // Final step - sell all remaining
        sellAmount = curTokenAmount;
      } else {
        // Partial sell according to the rule
        sellAmount = Math.min(
          Math.floor((investedAmount * sellPercent) / 100),
          curTokenAmount
        );
      }
      
      const txResult = await sellTokenSwap(
        mintAddress,
        sellAmount,
        stepIndex === 3,
        false
      );
      
      if (txResult) {
        logger.info(`[✅ STEP-SOLD] ${shortMint} | Successfully executed step ${stepIndex + 1} sell | Amount: ${sellAmount / 10 ** TOKEN_DECIMALS} | Price: $${currentPrice_usd.toFixed(6)}`);
        
        tokenSellingStep.set(mintAddress, stepIndex + 1);
        this.successfulSells++;
        
        if (stepIndex === 3) {
          this.stopMonitoring(mintAddress);
        } else {
          // Prepare next step transactions
          this.preparePotentialSellTransactions(mintAddress).catch(error => {
            logger.error(`[❌ PREPARE-ERROR] ${shortMint} | Error preparing next steps: ${error.message}`);
          });
        }
      } else {
        this.failedSells++;
        logger.error(`[❌ SELL-ERROR] ${shortMint} | Failed to execute step ${stepIndex + 1} sell`);
      }
    } catch (error) {
      this.failedSells++;
      logger.error(`[❌ FALLBACK-ERROR] ${shortMint} | Error during fallback profit sell step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`);
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
      
      // Clear cached evaluations
      priceEvaluationCache.delete(mintAddress);
      lastEvaluationTime.delete(mintAddress);
      lastEvaluatedPrice.delete(mintAddress);
      
      // Clean up prepared transactions for this token
      for (const key of Array.from(preparedSellTransactions.keys())) {
        if (key.startsWith(mintAddress)) {
          preparedSellTransactions.delete(key);
        }
      }
      
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
      priceEvaluationCache.clear();
      preparedSellTransactions.clear();
      
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
      
      // Clear performance log interval
      if (this.performanceLogInterval) {
        clearInterval(this.performanceLogInterval);
        this.performanceLogInterval = null;
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
      
      // Reset performance counters
      this.totalEvaluations = 0;
      this.successfulSells = 0;
      this.failedSells = 0;
      this.preparedTransactionsUsed = 0;
      this.preparedTransactionsFailed = 0;
      
      logger.info("[🛑 SHUTDOWN] Stopped all WebSocket monitoring");
      this.isInitialized = false;
    } catch (error) {
      logger.error(`[❌ STOP-ERROR] Error stopping all monitoring: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}