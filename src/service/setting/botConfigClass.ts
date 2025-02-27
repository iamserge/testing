import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BotSettingsModel } from "../../models/botsetting.model";
import { BotSettings } from "../../utils/types";
class BotConfigClass {
  private static memoryCache: any = null;

  // Main settings
  private isRunning: boolean = false;
  private workingHours: {
    start: string;
    end: string;
    enabled: boolean;
  } = {
    start: "05:00",
    end: "21:30",
    enabled: true,
  };
  private buyIntervalTime: number = 30;
  private sellIntervalTime: number = 2;

  // Buy settings
  private buy = {
    age: {
      start: 0,
      end: 30,
      enabled: true,
    },
    marketCap: {
      min: 8000,
      max: 15000,
      enabled: true,
    },
    maxDevHoldingAmount: {
      value: 10,
      enabled: false,
    },
    maxDevBuyAmount: {
      value: 10,
      enabled: false,
    },
    holders: {
      value: 10,
      enabled: false,
    },
    lastMinuteTxns: {
      value: 0,
      enabled: false,
    },
    lastHourVolume: {
      value: 0,
      enabled: false,
    },
    maxGasPrice: 0.00001,
    slippage: 100,
    jitoTipAmount: 0.0001,
    investmentPerToken: 0.0000001,
    xScore: {
      value: 30,
      enabled: true,
    },
  };

  // Sell settings
  private sell = {
    saleRules: [
      { percent: 10, revenue: 5 },
      { percent: 20, revenue: 10 },
      { percent: 30, revenue: 30 },
      { percent: 40, revenue: 50 },
    ],
    lossExitPercent: 30,
  };

  constructor() {
    this.initializeSettings();
  }

  private async initializeSettings() {
    const dbSettings =
      (await BotSettingsModel.findOne().lean()) as BotSettings | null;
    if (dbSettings) {
      console.log("DB Settings found");
      BotConfigClass.memoryCache = {
        mainConfig: dbSettings.mainConfig,
        buyConfig: dbSettings.buyConfig,
        sellConfig: dbSettings.sellConfig,
      };
      this.isRunning = dbSettings.mainConfig.isRunning;
      this.workingHours = dbSettings.mainConfig.workingHours;
      this.buyIntervalTime = dbSettings.mainConfig.buyIntervalTime;
      this.sellIntervalTime = dbSettings.mainConfig.sellIntervalTime;
      this.buy = dbSettings.buyConfig;
      this.sell = dbSettings.sellConfig;
    } else {
      console.log("DB Settings not found");
      BotConfigClass.memoryCache = {
        mainConfig: this.getMainConfig(),
        buyConfig: this.getBuyConfig(),
        sellConfig: this.getSellConfig(),
      };
      await this.saveSettings();
    }
  }
  private async saveSettings() {
    const settings = {
      mainConfig: this.getMainConfig(),
      buyConfig: this.getBuyConfig(),
      sellConfig: this.getSellConfig(),
      updatedAt: new Date(),
    };

    await BotSettingsModel.updateOne({}, { $set: settings }, { upsert: true });

    BotConfigClass.memoryCache = settings;
  }

  // Getter methods
  getIsRunning(): boolean {
    return this.isRunning;
  }

  getWorkingHours() {
    return this.workingHours;
  }

  getBuyIntervalTime(): number {
    return this.buyIntervalTime * 1000;
  }

  getSellIntervalTime(): number {
    return this.sellIntervalTime * 1000;
  }

  getMaxDevBuyAmount() {
    return this.buy.maxDevBuyAmount;
  }

  getXScore() {
    return this.buy.xScore;
  }

  getMaxGasPrice(): number {
    return this.buy.maxGasPrice;
  }

  getJitoTipAmountforBuy(): number {
    return this.buy.jitoTipAmount * LAMPORTS_PER_SOL;
  }

  getMainConfig() {
    return {
      isRunning: this.isRunning,
      workingHours: this.workingHours,
      buyIntervalTime: this.buyIntervalTime,
      sellIntervalTime: this.sellIntervalTime,
    };
  }

  getBuyConfig() {
    return { ...this.buy };
  }

  getSellConfig() {
    return { ...this.sell };
  }

  getSettings() {
    return BotConfigClass.memoryCache;
  }

  // Setter methods with persistence
  async setMainConfig(config: any): Promise<void> {
    this.isRunning = config.isRunning;
    this.workingHours = config.workingHours;
    this.buyIntervalTime = config.buyIntervalTime;
    this.sellIntervalTime = config.sellIntervalTime;
    await this.saveSettings();
  }

  async setBuyConfig(config: any): Promise<void> {
    this.buy = { ...this.buy, ...config };
    await this.saveSettings();
  }

  async setSellConfig(config: any): Promise<void> {
    this.sell = { ...this.sell, ...config };
    await this.saveSettings();
  }
}

export const SniperBotConfig = new BotConfigClass();
