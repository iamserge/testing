import { VersionedTransaction } from "@solana/web3.js";
import logger from "../logs/logger";
import { SniperBotConfig } from "../service/setting/botConfigClass";
import { connection, wallet } from "../config";
import {
  SPL_ACCOUNT_LAYOUT,
  TOKEN_PROGRAM_ID,
  TokenAccount,
} from "@raydium-io/raydium-sdk";
import {
  getPumpTokenPriceUSD,
  getTokenBalance,
} from "../service/pumpfun/pumpfun";
import { TOTAL_SUPPLY } from "./constants";
import {
  IDexScreenerResponse,
  ITxntmpData,
  SwapParam,
} from "./types";
import {
  saveTXonDB,
} from "../service/tx/TxService";
import { ITransaction, SniperTxns } from "../models/SniperTxns";
import { swap } from "../service/swap/swap";
import { getCachedSolPrice } from "../service/sniper/getBlock";
import { getTokenDataforAssets } from "../service/assets/assets";

export const formatTimestamp = (timestamp: number) => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

export const calculateTotalPercentage = (holders: any[]) => {
  return holders.reduce((total, holder) => total + holder.percentage, 0);
};

export async function sleepTime(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunkArray<T>(array: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(array.length / size) }, (v, i) =>
    array.slice(i * size, i * size + size)
  );
}

export function bufferFromUInt64(value: number | string) {
  let buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

export function readBigUintLE(
  buf: Buffer,
  offset: number,
  length: number
): number {
  switch (length) {
    case 1:
      return buf.readUint8(offset);
    case 2:
      return buf.readUint16LE(offset);
    case 4:
      return buf.readUint32LE(offset);
    case 8:
      return Number(buf.readBigUint64LE(offset));
  }
  throw new Error(`unsupported data size (${length} bytes)`);
}

export const isWorkingTime = (): boolean => {
  const currentTime = new Date();
  const currentHour = currentTime.getUTCHours();
  const currentMinute = currentTime.getUTCMinutes();

  const workingHours = SniperBotConfig.getWorkingHours();
  if (workingHours.enabled === false) return true; // dont check working time

  const [startHour, startMinute] = workingHours.start.split(":").map(Number);
  const [endHour, endMinute] = workingHours.end.split(":").map(Number);

  const currentTimeInMinutes = currentHour * 60 + currentMinute;
  const startTimeInMinutes = startHour * 60 + startMinute;
  const endTimeInMinutes = endHour * 60 + endMinute;

  return (
    currentTimeInMinutes >= startTimeInMinutes &&
    currentTimeInMinutes <= endTimeInMinutes
  );
};

export const isRunning = (): boolean => {
  return SniperBotConfig.getIsRunning();
};

export const getTokenPriceFromJupiter = async (mint: string) => {
  try {
    const BaseURL = `https://api.jup.ag/price/v2?ids=${mint}`;

    const response = await fetch(BaseURL);
    const data = await response.json();
    const price = data.data[mint]?.price;
    return price;
  } catch (error) {
    logger.error("Error fetching token price from Jupiter: " + error);
    return 0;
  }
};

export const getSolPrice = async () => {
  const WSOL = "So11111111111111111111111111111111111111112";
  const SOL_URL = `https://api.jup.ag/price/v2?ids=${WSOL}`;
  try {
    const BaseURL = SOL_URL;
    const response = await fetch(BaseURL);
    const data = await response.json();
    const price = data.data[WSOL]?.price;
    return price;
  } catch (error) {
    // logger.error("Error fetching SOL price: " + error);
    return 0;
  }
};

export const isSniping = (): boolean => {
  if (!isRunning()) return false;
  if (!isWorkingTime()) return false;
  return true;
};

export async function simulateTxn(txn: VersionedTransaction) {
  const { value: simulatedTransactionResponse } =
    await connection.simulateTransaction(txn, {
      replaceRecentBlockhash: true,
      commitment: "processed",
    });
  const { err, logs } = simulatedTransactionResponse;
  console.log("\n🚀 Simulate ~", Date.now());
  if (err) {
    console.error("* Simulation Error:", err, logs);
    throw new Error(
      "Simulation txn. Please check your wallet balance and slippage." +
        err +
        logs
    );
  }
}

export async function getWalletTokenAccount(): Promise<TokenAccount[]> {
  const walletTokenAccount = await connection.getTokenAccountsByOwner(
    wallet.publicKey,
    {
      programId: TOKEN_PROGRAM_ID,
    }
  );
  return walletTokenAccount.value.map((i) => ({
    pubkey: i.pubkey,
    programId: i.account.owner,
    accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
  }));
}
export async function getCurrentUSDMC(mint: string): Promise<number> {
  const { price } = await getPumpTokenPriceUSD(mint);
  return price * TOTAL_SUPPLY;
}

export async function getDexscreenerData(
  mint: string
): Promise<IDexScreenerResponse | null> {
  try {
    const url = `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    return null;
  }
}

export const sellTokenSwap = async (mint: string, amount: number, isAlert:boolean, isSellAll: boolean) => {
  try {
    if(!isSellAll && amount === 0) return;
    const botBuyConfig = SniperBotConfig.getBuyConfig();
    const { price: currentPrice_usd, pumpData } = await getPumpTokenPriceUSD(mint);
    const _tip = isSellAll ? 0.00001 : botBuyConfig.jitoTipAmount
    const swapParam: SwapParam = {
      mint: mint,
      amount: amount, // no decimals
      tip: _tip, // no decimals
      slippage: botBuyConfig.slippage, // 0.1 ~ 100
      is_buy: false,
      isSellAll: isSellAll,
      pumpData,
    };
    const swapResult = await swap(swapParam);
    if (!isSellAll && swapResult && amount > 0) {
      // const investedPrice_usd = Number(tokenData.investedPrice_usd);
      const buyTxn = await SniperTxns.findOne({
        mint: mint,
        swap: "BUY",
      });
      const investedPrice_usd = buyTxn?.swapPrice_usd || 0;      
      const { txHash} = swapResult;
      logger.info(` - 🧩 sell swap tx: https://solscan.io/tx/${txHash}`);
      const profit = (Number(currentPrice_usd - investedPrice_usd) * amount) / 1000_000;
      const profitPercent = Number(currentPrice_usd / investedPrice_usd - 1) * 100;
      const solPrice = getCachedSolPrice();
      const save_data: ITxntmpData = {
        isAlert: isAlert,
        txHash: txHash || "",
        mint: mint,
        swap: "SELL",
        swapPrice_usd: currentPrice_usd,
        swapAmount: amount / 1000_000,
        swapFee_usd: botBuyConfig.jitoTipAmount * solPrice,
        swapProfit_usd: profit,
        swapProfitPercent_usd: profitPercent,
      };

      saveTXonDB(save_data);
    } else {
      return null;
    }
  } catch (error) {
    console.log(error);
    return null;
  }
};
