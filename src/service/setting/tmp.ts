// import { LAMPORTS_PER_SOL } from "@solana/web3.js";

// class BotConfigClass {
//   // Main settings
//   private isRunning: boolean = false;
//   private workingHours: {
//     start: string;
//     end: string;
//     enabled: boolean;
//   } = {
//     start: "05:00",
//     end: "21:30",
//     enabled: true,
//   };
//   private intervalTime: number = 30;

//   // Buy settings
//   private buy: {
//     age: {
//       value: number;
//       enabled: boolean;
//     };
//     marketCap: {
//       min: number;
//       max: number;
//       enabled: boolean;
//     };
//     maxDevHoldingAmount: {
//       value: number;
//       enabled: boolean;
//     };
//     maxDevBuyAmount: {
//       value: number;
//       enabled: boolean;
//     };
//     holders: {
//       value: number;
//       enabled: boolean;
//     };
//     lastMinuteTxns: {
//       value: number;
//       enabled: boolean;
//     };
//     lastHourVolume: {
//       value: number;
//       enabled: boolean;
//     };
//     xScore: {
//       value: number;
//       enabled: boolean;
//     };
//     maxGasPrice: number;
//     slippage: number;
//     jitoTipAmount: number;
//     investmentPerToken: number;
//   } = {
//     age: {
//       value: 5, // 1m
//       enabled: true,
//     },
//     marketCap: {
//       min: 8000, // 1K
//       max: 10000000, // 10M usd
//       enabled: true,
//     },
//     maxDevHoldingAmount: {
//       value: 10, //10%
//       enabled: false,
//     },
//     maxDevBuyAmount: {
//       value: 10, // 10SOL
//       enabled: false,
//     },
//     holders: {
//       value: 10, // over 10
//       enabled: false,
//     },
//     lastMinuteTxns: {
//       value: 0,
//       enabled: false,
//     },
//     lastHourVolume: {
//       value: 0,
//       enabled: false,
//     },
//     maxGasPrice: 0.00001,
//     slippage: 100,
//     jitoTipAmount: 0.0001,
//     investmentPerToken: 0.0000001,
//     xScore: {
//       value: 30,
//       enabled: true,
//     },
//   };

//   // Sell settings
//   private sell: {
//     saleRules: Array<{
//       percent: number;
//       revenue: number;
//     }>;
//     lossExitPercent: number;
//   } = {
//     saleRules: [
//       {
//         percent: 10,
//         revenue: 5,
//       },
//       {
//         percent: 20,
//         revenue: 10,
//       },
//       {
//         percent: 30,
//         revenue: 30,
//       },
//       {
//         percent: 40,
//         revenue: 50,
//       },
//     ],
//     lossExitPercent: 30,
//   };

//   getIsRunning(): boolean {
//     return this.isRunning;
//   }

//   getWorkingHours(): { start: string; end: string; enabled: boolean } {
//     return this.workingHours;
//   }

//   getIntervalTime(): number {
//     return this.intervalTime * 1000;
//   }

//   getMaxDevBuyAmount(): { value: number; enabled: boolean } {
//     return this.buy.maxDevBuyAmount;
//   }

//   getXScore(): { value: number; enabled: boolean } {
//     return this.buy.xScore;
//   }

//   getMaxGasPrice(): number {
//     return this.buy.maxGasPrice;
//   }

//   getJitoTipAmountforBuy(): number {
//     return this.buy.jitoTipAmount * LAMPORTS_PER_SOL;
//   }

//   getMainConfig() {
//     return {
//       isRunning: this.isRunning,
//       workingHours: this.workingHours,
//       intervalTime: this.intervalTime,
//     };
//   }

//   setMainConfig(config: any): void {
//     this.isRunning = config.isRunning;
//     this.workingHours = config.workingHours;
//     this.intervalTime = config.intervalTime;
//   }

//   getBuyConfig() {
//     return {
//       age: this.buy.age,
//       marketCap: this.buy.marketCap,
//       holders: this.buy.holders,
//       lastMinuteTxns: this.buy.lastMinuteTxns,
//       lastHourVolume: this.buy.lastHourVolume,
//       maxDevHoldingAmount: this.buy.maxDevHoldingAmount,
//       maxDevBuyAmount: this.buy.maxDevBuyAmount,
//       xScore: this.buy.xScore,
//       maxGasPrice: this.buy.maxGasPrice,
//       slippage: this.buy.slippage,
//       jitoTipAmount: this.buy.jitoTipAmount,
//       investmentPerToken: this.buy.investmentPerToken,
//     };
//   }

//   setBuyConfig(config: any): void {
//     this.buy.age = config.age;
//     this.buy.marketCap = config.marketCap;
//     this.buy.holders = config.holders;
//     this.buy.lastMinuteTxns = config.lastMinuteTxns;
//     this.buy.lastHourVolume = config.lastHourVolume;
//     this.buy.maxDevHoldingAmount = config.maxDevHoldingAmount;
//     this.buy.maxDevBuyAmount = config.maxDevBuyAmount;
//     this.buy.xScore = config.xScore;
//     this.buy.maxGasPrice = config.maxGasPrice;
//     this.buy.slippage = config.slippage;
//     this.buy.jitoTipAmount = config.jitoTipAmount;
//     this.buy.investmentPerToken = config.investmentPerToken;
//   }

//   getSellConfig() {
//     return {
//       saleRules: this.sell.saleRules,
//       lossExitPercent: this.sell.lossExitPercent,
//     };
//   }
//   setSellConfig(config: any): void {
//     this.sell.saleRules = config.saleRules;
//     this.sell.lossExitPercent = config.lossExitPercent;
//   }
// }

// export const SniperBotConfig = new BotConfigClass();
