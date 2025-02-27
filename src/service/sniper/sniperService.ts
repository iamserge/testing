import { Commitment, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connection, START_TXT } from "../../config";
import { SniperBotConfig } from "../setting/botConfigClass";
import { getPumpData, getTokenBalance } from "../pumpfun/pumpfun";
import { TOTAL_SUPPLY } from "../../utils/constants";
import { swap } from "../swap/swap";
import { saveTXonDB } from "../tx/TxService";
import { getCachedSolPrice } from "./getBlock";
import logger from "../../logs/logger";
import {
  SwapParam,
  ITxntmpData,
  IDexScreenerResponse,
} from "../../utils/types";
import {
  isRunning,
  isWorkingTime,
  getDexscreenerData,
} from "../../utils/utils";

const PUMP_WALLET = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const COMMITMENT_LEVEL = "confirmed" as Commitment;
const BUY_MORNITOR_CYCLE = SniperBotConfig.getBuyIntervalTime();

export const validateToken = async (
  mint: string,
  dev: PublicKey,
  created_timestamp: number
) => {
  // age, mc(min, max), dev own, holders, last minute txns
  try {
    const [pumpData, _devHolding, allAccounts] = await Promise.all([
      getPumpData(new PublicKey(mint)),
      getTokenBalance(dev.toString(), mint),
      connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
      }),
    ]);
    const _age = (Date.now() - new Date(created_timestamp).getTime()) / 1000; // second
    const _mc = Number(pumpData?.marketCap);
    const _holders = allAccounts.length;
    const botBuyConfig = SniperBotConfig.getBuyConfig();
    // buy setting check
    let isValid = true;
    let start_T = 0;
    let end_T = 0;
    if (botBuyConfig.age.enabled) {
      start_T = botBuyConfig.age.start;
      end_T = botBuyConfig.age.end;
    } else {
      start_T = 0;
      end_T = 30 * 60;
    }
    if (_age < start_T || _age > end_T) isValid = false;
    if (
      botBuyConfig.marketCap.enabled &&
      !(botBuyConfig.marketCap.min <= _mc && _mc <= botBuyConfig.marketCap.max)
    )
      isValid = false;
    if (
      botBuyConfig.maxDevHoldingAmount.enabled &&
      Number(_devHolding || 0) >
        (TOTAL_SUPPLY / 100) * botBuyConfig.maxDevHoldingAmount.value
    )
      isValid = false;
    if (botBuyConfig.holders.enabled && _holders < botBuyConfig.holders.value)
      isValid = false;

    if (!isValid) return { isValid, pumpData: null };

    if (
      botBuyConfig.lastHourVolume.enabled ||
      botBuyConfig.lastMinuteTxns.enabled
    ) {
      const tmp: IDexScreenerResponse | any = await getDexscreenerData(mint);
      const dexScreenerData = tmp[0];
      if (!dexScreenerData.volume.h1) isValid = false;
      if (
        botBuyConfig.lastHourVolume.enabled &&
        dexScreenerData.volume.h1 < botBuyConfig.lastHourVolume.value
      )
        isValid = false;
      if (
        botBuyConfig.lastMinuteTxns.enabled &&
        dexScreenerData.txns.h1 < botBuyConfig.lastMinuteTxns.value
      )
        isValid = false;
    }

    return { isValid, pumpData };
  } catch (error) {
    logger.error(`${mint} Token validation error: ${error}`);
    return { isValid: false, pumpData: null };
  }
};

const monitorToken = async (
  mint: string,
  user: PublicKey,
  created_timestamp: number
) => {
  let attempts = 60; // 30 minutes with 30-second intervals
  const interval = setInterval(async () => {
    if (!isRunning() || !isWorkingTime()) {
      clearInterval(interval);
    }
    try {
      const { isValid, pumpData } = await validateToken(
        mint,
        user,
        created_timestamp
      );
      const botBuyConfig = SniperBotConfig.getBuyConfig();
      const _age = (Date.now() - new Date(created_timestamp).getTime()) / 1000;
      const end_T = botBuyConfig.age.end;
      if (botBuyConfig.age.enabled && _age >= end_T) {
        logger.info(`[sniperService] Token ${mint} 's age is over. Skipping...`);
        clearInterval(interval);
        return;
      }


      if (isValid && pumpData) {
        console.log(`[sniperService] Token ${mint} is valid. Buying...`);
        const buyConfig = SniperBotConfig.getBuyConfig();
        const tip_sol = buyConfig.jitoTipAmount || 0.00001;
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
        if (!isRunning() || !isWorkingTime()) {
          clearInterval(interval);
          return;
        }

        const swapResult = await swap(swapParam);
        if (swapResult) {
          const { txHash, price, inAmount, outAmount } = swapResult;
          logger.info(` - ⛳ buy swap tx: https://solscan.io/tx/${txHash}`);
          const solPrice = getCachedSolPrice();
          const save_data: ITxntmpData = {
            isAlert: false,
            txHash: txHash || "",
            mint: mint,
            swap: "BUY",
            swapPrice_usd: price,
            swapAmount: outAmount,
            swapFee_usd: tip_sol * solPrice,
            swapProfit_usd: 0,
            swapProfitPercent_usd: 0
          };
          saveTXonDB(save_data);
          clearInterval(interval);
          return;
        }
      }

      attempts--;
      if (attempts <= 0) {
        clearInterval(interval);
        logger.info(`Monitoring ended for token ${mint}`);
      }
    } catch (error) {
      logger.error(`Monitor error: ${error}`);
      clearInterval(interval);
    }
  }, BUY_MORNITOR_CYCLE);
};

export async function sniperService() {
  logger.info(START_TXT.sniper);
  try {
    connection.onLogs(
      PUMP_WALLET,
      async ({ logs, err, signature }) => {
        try {
          if (err) return;
          if (!isRunning()) return;
          if (!isWorkingTime()) return;

          if (
            logs &&
            logs.some((log) =>
              log.includes("Program log: Instruction: InitializeMint2")
            )
          ) {
            const txn = await connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });

            //@ts-ignore
            const accountKeys = txn?.transaction.message.instructions.find((ix) => ix.programId.toString() === PUMP_WALLET.toBase58())?.accounts as PublicKey[];

            if (accountKeys) {
              const mint = accountKeys[0];
              const user = accountKeys[7]; // dev address
              if (txn && txn.meta) {
                const solSpent =
                  Math.abs(txn.meta.postBalances[0] - txn.meta.preBalances[0]) /
                  LAMPORTS_PER_SOL;
                const maxDevBuyAmount = SniperBotConfig.getMaxDevBuyAmount();

                if (
                  maxDevBuyAmount.enabled &&
                  solSpent > maxDevBuyAmount.value
                ) {
                  return;
                }
                const created_timestamp = Date.now();
                console.log(`- 🆕 ${mint.toBase58()} is created`);
                monitorToken(mint.toBase58(), user, created_timestamp);
              }
            }
          }
        } catch (e: any) {
          logger.error("* onLogs 1 error: " + e.message);
        }
      },
      COMMITMENT_LEVEL
    );
  } catch (e: any) {
    logger.error("* onLogs 2 error: " + e.message);
  }
}
