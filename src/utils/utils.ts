import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
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
import { PUMP_FUN_PROGRAM, TOTAL_SUPPLY } from "./constants";
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

const WSOL = "So11111111111111111111111111111111111111112";

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

export const getSwapAmountByTxHash = async (txHash: string): Promise<{tokenAmount: number, solAmount: number}> => {
  try {
    let txn;
    while(!txn) {
      txn = await connection.getParsedTransaction(txHash,
        { maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
         },
      );
      sleepTime(2000);
    }
    if (
      txn &&
      txn.meta &&
      txn.meta.preTokenBalances &&
      txn.meta.postTokenBalances
    ) {
      const preData = txn.meta.preTokenBalances;
      const postData = txn.meta.postTokenBalances;
      let tokenAmount = 0;
      let solAmount = 0;
      const mints: { mint: string; amount: number }[] = [];
      for (const item1 of preData) {
        const _mint1 = item1.mint;
        const _owner1 = item1.owner;
        for (const item2 of postData) {
          const _mint2 = item2.mint;
          const _owner2 = item2.owner;
          if (_mint1 === _mint2 && _owner1 === _owner2) {
            const deltaAmount =
              Number(item1.uiTokenAmount.uiAmount) -
              Number(item2.uiTokenAmount.uiAmount);
            const mint = _mint1;
            if (deltaAmount === 0) continue;
            mints.push({ mint: mint, amount: deltaAmount });
          }
        }
      }
      // txn.meta.preBalances.forEach((item, index) => console.log(item - txn.meta.postBalances[index]));
      const mint_account = new PublicKey(mints[0].mint).toBuffer();
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mint_account],
        PUMP_FUN_PROGRAM
      );
      const id = txn.transaction.message.accountKeys.findIndex((key) => key.pubkey.equals(bondingCurve));
      // console.log(id);
      solAmount = Math.abs((txn.meta.preBalances[id] - txn.meta.postBalances[id]) / LAMPORTS_PER_SOL);
      tokenAmount = Math.abs(mints[0].amount);
      return {
        tokenAmount,
        solAmount
      };
    }
    else
      throw new Error("failed to fetch txn swap data");
  } catch (error: any) {
    console.log("Error while running getSwapAmountByTxHash", error.message);
    return {
      tokenAmount: 0,
      solAmount: 0
    };
  }
}

export const getSolPrice = async () => {
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
        err
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

export const sellTokenSwap = async (mint: string, amount: number, isAlert: boolean, isSellAll: boolean): Promise<string|null> => {
  const shortMint = mint.slice(0, 8) + '...';
  
  try {
    if (!isSellAll && amount === 0) {
      logger.error(`[❌ INVALID-INPUT] ${shortMint} | Cannot sell zero tokens. Operation aborted.`);
      throw new Error("Amount is zero");
    }
    
    logger.info(`[💰 SELL-REQUEST] ${shortMint} | Amount: ${(amount / 1000_000).toFixed(6)} | isAlert: ${isAlert} | isSellAll: ${isSellAll}`);
    
    const botBuyConfig = SniperBotConfig.getBuyConfig();
    
    // Get token price and exchange information
    logger.info(`[📊 PRICE-CHECK] ${shortMint} | Fetching current token price...`);
    const { price: currentPrice_usd, pumpData, isRaydium } = await getPumpTokenPriceUSD(mint);
    
    if (!currentPrice_usd || currentPrice_usd === 0) {
      logger.error(`[❌ PRICE-ERROR] ${shortMint} | Failed to get valid price information`);
      return null;
    }
    
    logger.info(`[📈 PRICE-INFO] ${shortMint} | Current price: $${currentPrice_usd.toFixed(6)} | Exchange: ${isRaydium ? "Raydium" : "Pumpfun"}`);
    
    // Adjust tip amount based on isSellAll
    const tipAmount = isSellAll ? 0.00001 : botBuyConfig.jitoTipAmount;
    logger.info(`[💵 FEE-INFO] ${shortMint} | Using tip amount: ${tipAmount} SOL`);
    
    // Create swap parameters
    const swapParam: SwapParam = {
      mint: mint,
      amount: amount,
      tip: tipAmount,
      slippage: botBuyConfig.slippage,
      is_buy: false,
      isSellAll: isSellAll,
      pumpData,
    };
    
    // Execute the swap
    logger.info(`[🔄 EXECUTING] ${shortMint} | Calling swap function with slippage: ${botBuyConfig.slippage}%`);
    const swapResult = await swap(swapParam);
    
    if (!swapResult) {
      logger.error(`[❌ SWAP-FAILED] ${shortMint} | The swap function returned null`);
      return null;
    }
    
    const { txHash, price: executedPrice_usd, inAmount, outAmount, } = swapResult;
    logger.info(`[✅ SWAP-SUCCESS] ${shortMint} | Swap executed at price: $${executedPrice_usd.toFixed(6)}`);
    logger.info(`[📝 TX-DETAILS] ${shortMint} | TxHash: ${txHash?.slice(0, 8)}... | In: ${inAmount.toFixed(6)} tokens | Out: ${outAmount.toFixed(6)} SOL`);
    
    // For regular (non-sellAll) sells, we need to record the transaction
    if (!isSellAll && amount > 0) {
      // Lookup the buy transaction to calculate profit
      const buyTxn = await SniperTxns.findOne({
        mint: mint,
        swap: "BUY",
      });
      
      if (!buyTxn) {
        logger.warn(`[⚠️ NO-BUY-RECORD] ${shortMint} | No buy transaction found for this token`);
      }
      
      const investedPrice_usd = buyTxn?.swapPrice_usd || 0;
      const profit = (Number(executedPrice_usd - investedPrice_usd) * amount) / 1000_000;
      const profitPercent = Number(executedPrice_usd / investedPrice_usd - 1) * 100;
      
      logger.info(`[💹 PROFIT-CALC] ${shortMint} | Buy price: $${investedPrice_usd.toFixed(6)} | Profit: $${profit.toFixed(2)} (${profitPercent.toFixed(2)}%)`);
      
      const solPrice = getCachedSolPrice();
      
      // Prepare transaction data for database
      const save_data: ITxntmpData = {
        isAlert: isAlert,
        txHash: txHash || "",
        mint: mint,
        swap: "SELL",
        swapPrice_usd: executedPrice_usd,
        swapAmount: inAmount,
        swapFee_usd: tipAmount * solPrice,
        swapProfit_usd: profit,
        swapProfitPercent_usd: profitPercent,
        dex: "Pumpfun"
      };
      
      // Save transaction to database
      logger.info(`[💾 SAVING-TX] ${shortMint} | Recording transaction in database`);
      await saveTXonDB(save_data);
    } else if (swapResult) {
      // For sellAll operations, we don't need detailed profit calculations
      logger.info(`[🔥 CLEANUP] ${shortMint} | Token cleaned up successfully with sellAll option`);
    }
    
    return txHash;
  } catch (error: any) {
    logger.error(`[❌ SELL-ERROR] ${shortMint} | Error during sellTokenSwap: ${error.message}`);
    if (error.stack) {
      logger.error(`[❌ STACK-TRACE] ${shortMint} | ${error.stack.split('\n')[0]}`);
    }
    return null;
  }
};
