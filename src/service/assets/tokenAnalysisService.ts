import { ITokenAnalysisData } from "../../utils/types";
import { ITransaction, SniperTxns } from "../../models/SniperTxns";
import logger from "../../logs/logger";

class TokenAnalysisCache {
  private static instance: TokenAnalysisCache;
  private cache: Map<string, ITokenAnalysisData> = new Map();

  private constructor() {
    this.initializeCache();
  }

  public static getInstance(): TokenAnalysisCache {
    if (!TokenAnalysisCache.instance) {
      TokenAnalysisCache.instance = new TokenAnalysisCache();
    }
    return TokenAnalysisCache.instance;
  }

  private async initializeCache(): Promise<void> {
    try {
      logger.info("Initializing cache...");
      const transactions = await SniperTxns.find().sort({ txTime: 1 });
      transactions.forEach((tx) => {
        this.updateCacheFromTransaction(tx);
      });
      logger.info(`Cache initialized with ${this.cache.size} tokens`);
    } catch (error) {
      logger.error(`Cache initialization error: ${error}`);
    }
  }

  public updateCacheFromTransaction(tx: ITransaction): void {
    const existing: ITokenAnalysisData = this.cache.get(tx.mint) || {
      mint: tx.mint,
      tokenName: tx.tokenName,
      tokenSymbol: tx.tokenSymbol,
      tokenImage: tx.tokenImage,
      tokenCreateTime: tx.txTime,

      currentAmount: 0,
      realisedProfit: 0,
      unRealizedProfit: 0,
      totalFee: 0,
      sellingStep: 1,
      pnl: { profit_usd: 0, percent: 0 },
      holding: { value_usd: 0,  },
    };

    if (tx.swap === "BUY") {
      existing.investedAmount = tx.swapAmount;
      existing.investedPrice_usd = tx.swapPrice_usd;
      existing.investedMC_usd = tx.swapMC_usd;
      existing.investedAmount_usd = tx.swapAmount * tx.swapPrice_usd;

      existing.currentAmount = (existing.currentAmount || 0) + tx.swapAmount;
    } else if (tx.swap === "SELL") {
      existing.currentAmount = (existing.currentAmount || 0) - tx.swapAmount;
      existing.realisedProfit = (existing.realisedProfit || 0) + (tx.swapProfit_usd || 0);
    }
    existing.currentAmount = Math.max( Number(Number(existing.currentAmount).toFixed(6)), 0);
    // Update holding info
    existing.holding.value_usd = (existing.currentAmount || 0) * tx.swapPrice_usd;

    // Update PNL
    if (existing.investedPrice_usd) {
      existing.pnl.profit_usd = (tx.swapPrice_usd - existing.investedPrice_usd) * (existing.currentAmount || 0);
      existing.pnl.percent = (tx.swapPrice_usd / existing.investedPrice_usd - 1) * 100;
    }

    existing.unRealizedProfit = 0;
    existing.totalFee = (existing.totalFee || 0) + tx.swapFee_usd;

    this.cache.set(tx.mint, existing);
  }

  public getTokenAnalysis(mint: string): ITokenAnalysisData | undefined {
    return this.cache.get(mint);
  }

  public getAllTokenAnalysis(): ITokenAnalysisData[] {
    return Array.from(this.cache.values());
  }
  public clearCache(): void {
    // logger.info("Clearing token analysis cache...");
    this.cache.clear();
    // logger.info("Token analysis cache cleared successfully");
}

}

export const TokenAnalysis = TokenAnalysisCache.getInstance();
