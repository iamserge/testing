import { LiquidityPoolKeys } from "@raydium-io/raydium-sdk";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

export type SwapParam = {
  mint: string;
  amount: number; // no decimals
  tip: number; // no decimals
  slippage: number; // 0.1 ~ 100
  is_buy: boolean;
  isPumpfun?: boolean;
  isSellAll?: boolean;
  pumpData?: {
    price: number,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey,
    virtualSolReserves: number,
    virtualTokenReserves: number,
  },
  raydium?: {
    poolKeys: LiquidityPoolKeys;
  }
};

export type SellSwapParam = {
  mint: string;
  amount: number; // no decimals
  isAlert: boolean;
  isSellAll: boolean;
  isManual?: boolean;
}

export type IMonitor = {
  isMonitor: boolean;
  poolKeys?: LiquidityPoolKeys;
}

export type BuyInsParam = {
  mint: PublicKey;
  owner: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  maxSol: number;
  splOut: number;
};

export type SellInsParam = {
  mint: PublicKey;
  owner: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  splIn: number;
};

export type AmountsParam = {
  solSpent: number;
  splBought: number;
  solIn: number;
};

export type PumpData = {
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  virtualSolReserves: number;
  virtualTokenReserves: number;
  realTokenReserves: number;
  realSolReserves: number;
  totalSupply: number;
  progress: number;
  price: number;
  marketCap: number;
};

export interface ITxntmpData {
  isAlert: boolean;
  txHash: string;
  mint: string;
  swap: "BUY" | "SELL";
  swapPrice_usd: number;
  swapAmount: number;
  swapSolAmount?: number;
  swapFee_usd: number;
  swapProfit_usd?: number;
  swapProfitPercent_usd?: number;
}

export interface ISwapTxResponse {
  vTxn: VersionedTransaction;
  inAmount: number;
  outAmount: number;
  price?: number;
}

export interface ISwapHashResponse {
  txHash: string | null;
  price: number;
  inAmount: number;
  outAmount: number;
}

export interface ITokenAnalysisData {
  mint: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenImage?: string;
  tokenCreateTime?: number;

  investedAmount?: number;
  investedPrice_usd?: number;
  investedMC_usd?: number;
  investedAmount_usd?: number;

  currentAmount?: number;
  currentPrice_usd?: number;
  currentMC_usd?: number;

  // fdv?: number;

  pnl: {
    profit_usd?: number;
    percent?: number;
  };
  holding: {
    value_usd?: number;
    // tokenAmount?: number;
  };
  sellingStep?: number;
  revenue?: number;
  realisedProfit?: number;
  unRealizedProfit?: number;
  totalFee?: number;
}
export interface IAlertMsg {
  imageUrl: string;
  title: string;
  content: string;
  link: string;
  time: number;
  isRead: boolean;
}

export interface IDexScreenerResponse {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns: {
    m5: {
      buys: number;
      sells: number;
    };
    h1: {
      buys: number;
      sells: number;
    };
    h6: {
      buys: number;
      sells: number;
    };
    h24: {
      buys: number;
      sells: number;
    };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  fdv: number;
  marketCap: number;
  pairCreatedAt: number;
}


interface MainConfig {
  isRunning: boolean;
  workingHours: {
    start: string;
    end: string;
    enabled: boolean;
  };
  buyIntervalTime: number;
  sellIntervalTime: number;
}

interface BuyConfig {
  age: {
    start: number;
    end: number;
    enabled: boolean;
  };
  marketCap: {
    min: number;
    max: number;
    enabled: boolean;
  };
  maxDevHoldingAmount: {
    value: number;
    enabled: boolean;
  };
  maxDevBuyAmount: {
    value: number;
    enabled: boolean;
  };
  holders: {
    value: number;
    enabled: boolean;
  };
  lastMinuteTxns: {
    value: number;
    enabled: boolean;
  };
  lastHourVolume: {
    value: number;
    enabled: boolean;
  };
  maxGasPrice: number;
  slippage: number;
  jitoTipAmount: number;
  investmentPerToken: number;
  xScore: {
    value: number;
    enabled: boolean;
  };
}

interface SellConfig {
  saleRules: Array<{
    percent: number;
    revenue: number;
  }>;
  lossExitPercent: number;
}

export interface BotSettings {
  mainConfig: MainConfig;
  buyConfig: BuyConfig;
  sellConfig: SellConfig;
  updatedAt: Date;
}