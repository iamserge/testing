import { START_TXT, wallet } from "../../config";
import { ITransaction, SniperTxns } from "../../models/SniperTxns";
import { getWalletTokens } from "../assets/assets";
import { getPumpTokenPriceUSD, getTokenBalance } from "../pumpfun/pumpfun";
import { SniperBotConfig } from "../setting/botConfigClass";
import { TOKEN_DECIMALS, TOTAL_SUPPLY } from "../../utils/constants";
import logger from "../../logs/logger";
import { LiquidityPoolKeys } from "@raydium-io/raydium-sdk";
import { sellTokenSwap } from "../../utils/utils";
import { clear } from "console";

// const SELL_MORNITOR_CYCLE = SniperBotConfig.getSellIntervalTime();
const SELL_MORNITOR_CYCLE = 3 * 1000;

const isMonitor: Map<string, boolean> = new Map();
const tokenSellingStep: Map<string, number> = new Map();
const tokenCreatedTime: Map<string, number> = new Map();

const poolKeyMap: Map<string, LiquidityPoolKeys> = new Map();
export function getPoolKeyMap(mint: string) {
  const poolKey = poolKeyMap.get(mint);
  // console.log("poolKeyMap is", poolKey?.id.toBase58());
  return poolKey;
}
export function setPoolKeyMap(mint: string, poolKey: LiquidityPoolKeys) {
  poolKeyMap.set(mint, poolKey);
  const pid = getPoolKeyMap(mint)?.id;
  // console.log("poolKeyMap is updated", pid);
}

let botSellConfig = SniperBotConfig.getSellConfig();
let botBuyConfig = SniperBotConfig.getBuyConfig();

const oneMonitorTokenForSell = async (mint: string) => {
  const tokenTxns = await SniperTxns.find({ mint: mint }).sort({ date: -1 });
  const buyTx: ITransaction = tokenTxns.filter((txn) => txn.swap === "BUY")[0];
  const investedPrice_usd = Number(buyTx?.swapPrice_usd);
  const investedAmount = Number(buyTx?.swapAmount) * 10 ** TOKEN_DECIMALS; //3.123412
  if (!investedPrice_usd) return;

  isMonitor.set(mint, true);
  const selling_step = tokenTxns.length - 1;
  tokenSellingStep.set(mint, selling_step);

  const oneMonitor = setInterval(async () => {
    const now = Date.now();
    const curTokenAmount = await getTokenBalance(
      // with decimals
      wallet.publicKey.toBase58(),
      mint
    );
    if (curTokenAmount === 0) {
      clearInterval(oneMonitor);
      return;
    }

    if (!tokenCreatedTime.get(mint)) {
      const buyTxn = await SniperTxns.findOne({ mint, swap: "BUY" });
      if (!buyTxn) {
        clearInterval(oneMonitor);
        return;
      }
      tokenCreatedTime.set(mint, buyTxn.txTime);
    }

    const selling_step = tokenSellingStep.get(mint) || 0;
    if (selling_step >= 4) {
      console.log(` - selling step is larger than 4. ${mint}`);
      clearInterval(oneMonitor);
      return;
    }

    const { price: currentPrice_usd } = await getPumpTokenPriceUSD(mint);

    // Auto sell tokens if MC < $7K and age > 48h
    const createdTime = tokenCreatedTime.get(mint) || 0;
    if (currentPrice_usd * TOTAL_SUPPLY < 7000 && now - createdTime > 2 * 24 * 60 * 60 * 1000) {
      console.log(` - 💯 sell ${mint} because of MC < $7K and age > 48h`);
      sellTokenSwap(mint, curTokenAmount, true, false);
      tokenSellingStep.set(mint, (tokenSellingStep.get(mint) || 0) + 1);
      clearInterval(oneMonitor);
      return;
    }

    const sellRules = botSellConfig.saleRules;
    const sellSumPercent = sellRules.reduce(
      (acc: any, rule: any) => acc + rule.percent, 0);

    const raisePercent = (currentPrice_usd / investedPrice_usd - 1) * 100;
    if (raisePercent < 0 
      && Math.abs(raisePercent) > botSellConfig.lossExitPercent) {
        
      logger.info(` - 💯 sell cuz low price: ${mint}`);
      sellTokenSwap(mint, curTokenAmount, true, false);
      tokenSellingStep.set(mint, (tokenSellingStep.get(mint) || 0) + 1);
      clearInterval(oneMonitor);
    }
    const cur_step = tokenSellingStep.get(mint) || 0;
    for (let checkStp = cur_step; checkStp < 4; checkStp++)
      if (raisePercent >= sellRules[checkStp].revenue) {
        console.log(
          "checkstep & revenue & setting value",
          checkStp,
          raisePercent,
          sellRules[checkStp].revenue
        );

        const sellPercent = sellRules[checkStp].percent;
        let sellAmount = 0;
        if (checkStp === 3 && sellSumPercent === 100) {
          sellTokenSwap(mint, curTokenAmount, true, false);
        } else {
          sellAmount = Math.min(Math.floor((investedAmount * sellPercent) / 100), curTokenAmount);
          let isAlert = sellAmount === curTokenAmount;

          logger.info(`${mint} sellstep: ${checkStp + 1}, sellAmount: ${sellAmount}, ${sellPercent}%`);

          sellTokenSwap(mint, sellAmount, isAlert, false);
          if(sellAmount > 0) tokenSellingStep.set(mint, (tokenSellingStep.get(mint) || 0) + 1);
        }
      }

    // check sell
  }, SELL_MORNITOR_CYCLE);
};

export const sellMonitorService = async () => {
  logger.info(START_TXT.sell);
  const sellMonitor = setInterval(async () => {
    botSellConfig = SniperBotConfig.getSellConfig();
    botBuyConfig = SniperBotConfig.getBuyConfig();

    const tokens = await getWalletTokens(wallet.publicKey);

    tokens.forEach(async (token) => {
      if (!isMonitor.get(token.mint)) oneMonitorTokenForSell(token.mint);
    });
  }, SELL_MORNITOR_CYCLE);
};
