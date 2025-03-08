import { Commitment, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connection, metaplex, START_TXT, wallet } from "../../config";
import { SniperBotConfig } from "../setting/botConfigClass";
import { getPumpData, getTokenBalance } from "../pumpfun/pumpfun";
import { PUMPFUN_IMG, TOTAL_SUPPLY } from "../../utils/constants";
import { swap } from "../swap/swap";
import { saveTXonDB } from "../tx/TxService";
import { getCachedSolPrice } from "./getBlock";
import logger from "../../logs/logger";
import { SwapParam, ITxntmpData, IAlertMsg, PumpData } from "../../utils/types";
import {
  isRunning,
  isWorkingTime,
  getDexscreenerData,
} from "../../utils/utils";
import chalk from "chalk";
import { DBTokenList, IToken } from "../../models/TokenList";
import { getWalletBalanceFromCache } from "./getWalletBalance";
import { createAlert } from "../alarm/alarm";
import { WssMonitorService } from "./wssMonitorService";
import { tokenMonitorThread2Sell } from "./sellMonitorService";
import { USE_WSS } from "../../index"; // You may need to export this from index.ts


const PUMP_WALLET = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const COMMITMENT_LEVEL = "confirmed" as Commitment;
let BUY_MORNITOR_CYCLE = SniperBotConfig.getBuyIntervalTime();

const tokenBuyingMap: Map<string, number> = new Map();
export const removeTokenBuyingMap = (value: string) => {
  tokenBuyingMap.delete(value);
};

//---------------------- token validation ----------------------//
export const validateToken = async (mint: string, dev: PublicKey) => {
  try {
    let pumpid = 0;
    let devHoldingId = 0;
    let allAccountsId = 0;
    let dexScreenerId = 0;
    const botBuyConfig = SniperBotConfig.getBuyConfig();

    const promiseArray: any[] = [];
    promiseArray.push(getPumpData(new PublicKey(mint)));
    if (botBuyConfig.maxDevHoldingAmount.enabled) {
      promiseArray.push(getTokenBalance(dev.toString(), mint));
      devHoldingId = promiseArray.length - 1;
    }

    if (botBuyConfig.holders.enabled) {
      promiseArray.push(
        connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
          filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
        })
      );
      allAccountsId = promiseArray.length - 1;
    }
    if (
      botBuyConfig.lastHourVolume.enabled ||
      botBuyConfig.lastMinuteTxns.enabled
    ) {
      promiseArray.push(getDexscreenerData(mint));
      dexScreenerId = promiseArray.length - 1;
    }

    const now = Date.now();
    const promiseResult = await Promise.all(promiseArray);
    const pumpData = promiseResult[pumpid];
    // console.log(`- Fetched token ${mint} data: `, pumpData?.marketCap);
    // console.log(`- Fetched pumpfun token ${mint} data: ${pumpData} `, promiseResult.length, (Date.now() - now)/100 + "ms");
    const _devHolding = promiseResult[devHoldingId];
    const allAccounts = promiseResult[allAccountsId];
    const dexData = promiseResult[dexScreenerId];

    // const [pumpData, _devHolding, allAccounts] = await Promise.all([
    //   getPumpData(new PublicKey(mint)),
    //   getTokenBalance(dev.toString(), mint),
    //   connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    //     filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
    //   }),
    // ]);
    const _mc = Number(pumpData?.marketCap);
    const _holders = allAccounts?.length??0;
    let isValid = true;
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

    if (
      botBuyConfig.lastHourVolume.enabled ||
      botBuyConfig.lastMinuteTxns.enabled
    ) {
      const dexScreenerData = dexData[0];
      if (!dexScreenerData.volume.h1) isValid = false;
      if (
        botBuyConfig.lastHourVolume.enabled &&
        dexScreenerData.volume.h1 < botBuyConfig.lastHourVolume.value
      )
        isValid = false;
      const _txns =
        dexScreenerData.txns.h1.buys + dexScreenerData.txns.h1.sells || 0;
      if (
        botBuyConfig.lastMinuteTxns.enabled &&
        _txns < botBuyConfig.lastMinuteTxns.value
      )
        isValid = false;
    }

    return { isValid, pumpData };
  } catch (error) {
    logger.error(`${mint} Token validation error: ${error}`);
    return { isValid: false, pumpData: null };
  }
};

const checkDuplicates = async (mint: string): Promise<boolean> => {
  try {
    const tmpdata = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
    const data = await tmpdata.json();
    let tokenName = data.name;
    let tokenSymbol = data.symbol;
    let tokenImage = data.image;
    if (!tokenSymbol) {
      const metaPlexData = await metaplex
        .nfts()
        .findByMint({ mintAddress: new PublicKey(mint) });
      tokenName = metaPlexData.name;
      tokenSymbol = metaPlexData.symbol;
      tokenImage = metaPlexData.json?.image;
    }

    const duplicateToken = await DBTokenList.findOne({
      tokenSymbol: tokenSymbol,
    });
    if (duplicateToken) {
      const expired =
        Date.now() - duplicateToken.saveTime > 1000 * 60 * 60 * 24 * 5;
      if (expired) {
        DBTokenList.findOneAndUpdate(
          { mint: duplicateToken.mint },
          { saveTime: Date.now() }
        );
      }
        return true;
    } else {
      // not exist on db
      const tokenData: Partial<IToken> = {
        mint,
        tokenName,
        tokenSymbol,
        tokenImage,
        saveTime: Date.now(),
      };

      const newToken = new DBTokenList(tokenData);
      newToken.save();
      // logger.info(`New token saved: ${tokenSymbol}`);
      return false;
    }
  } catch (error) {
    // logger.error(`${mint} checkDuplicates error: ${error}`);
    return true;
  }
};

const monitorToken = async (
  mint: string,
  pumpTokenData: PumpData,
  user: PublicKey,
  created_timestamp: number
) => {
  const run = async () => {
    try {
      const botBuyConfig = SniperBotConfig.getBuyConfig();

      const _age = (Date.now() - created_timestamp) / 1000;
      let start_T = 0;
      let end_T = 30 * 60;
      if (botBuyConfig.age.enabled) {
        start_T = botBuyConfig.age.start;
        end_T = botBuyConfig.age.end;
      }
      let isValid: boolean = true;
      let pumpData: PumpData = pumpTokenData;
      if(end_T > 10){
        const result = await validateToken(mint, user);
        isValid = result.isValid;
        pumpData = result.pumpData;
      }
      if (_age < start_T) throw new Error("age: " + _age.toString() + ", start_t: " + start_T.toString() + ", isvalid:" + isValid);
      if (_age > end_T) {
        logger.info(
          `[sniperService] Token ${mint} 's age is over. ${_age} s,  Skipping...`
        );
        return;
      }

      if (!isRunning() || !isWorkingTime()) {
        return;
      }

      if (isValid && pumpData) {
        logger.info(
          chalk.green(`[sniperService] Token ${mint} is valid. Buying...`)
        );

        //------------------------- swap Initialize --------------------------//

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

        //------------------------- add alert if wallet balance is not enough --------------------------//
        const walletBalance = getWalletBalanceFromCache(); // get wallet balance from cache
        if (walletBalance < 0.03) {
          logger.info(
            `[ sniper ] ${mint} wallet balance: ${walletBalance}SOL is not enough. Skipping...`
          );
          const newAlert: IAlertMsg = {
            imageUrl: PUMPFUN_IMG,
            title: "Insufficient Wallet Balance",
            content: `🚨 Your wallet needs more SOL to continue trading! 
            Current operation has been paused for your safety. Please top up your wallet to resume trading operations.`,
            link: wallet.publicKey.toBase58(),
            time: Date.now(),
            isRead: false,
          };
          createAlert(newAlert);
          // bot turn off
          const botMainconfig = SniperBotConfig.getMainConfig();
          SniperBotConfig.setMainConfig({
            ...botMainconfig,
            isRunning: false,
          });
          return;
        }

        //------------------------- swap --------------------------//
        const swapResult = await swap(swapParam);
        if (swapResult) {
          const { txHash, price, inAmount, outAmount } = swapResult;
          logger.info(`[ - ] ⛳ buy swap tx: https://solscan.io/tx/${txHash}`);
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
            swapProfitPercent_usd: 0,
            dex: "Pumpfun",
          };
          
          // Save transaction to database
          await saveTXonDB(save_data);
          
          // NEW CODE: Immediately start monitoring this token
          logger.info(`[🔄 HANDOFF] ${mint.slice(0, 8)}... | Initiating immediate sell monitoring after purchase`);
          try {
            if (USE_WSS) {
              // Start WebSocket monitoring for this token
              await WssMonitorService.startMonitoring(mint);
              const buyTime = Date.now();
              logger.trackBuyToMonitorDelay(mint, buyTime, Date.now());
              logger.info(`[✅ MONITOR-INIT] ${mint.slice(0, 8)}... | WebSocket monitoring started successfully`);
            } else {
              // Start interval-based monitoring for this token
              await tokenMonitorThread2Sell(mint);
              const buyTime = Date.now(); 
              logger.trackBuyToMonitorDelay(mint, buyTime, Date.now());
              logger.info(`[✅ MONITOR-INIT] ${mint.slice(0, 8)}... | Interval monitoring started successfully`);
            }
          } catch (monitorError) {
            logger.error(`[❌ MONITOR-ERROR] ${mint.slice(0, 8)}... | Failed to initialize monitoring: ${monitorError instanceof Error ? monitorError.message : String(monitorError)}`);
          }
          
          return;
        }
      }
      setTimeout(run, BUY_MORNITOR_CYCLE);
    } catch (error) {
      logger.error(`[sniperService] Token ${mint} monitor error: ${error}`);
      setTimeout(run, BUY_MORNITOR_CYCLE);
    }
  };
  run();
};

export async function sniperService() {
  logger.info(START_TXT.sniper);
  try {
    connection.onLogs(
      PUMP_WALLET,
      async ({ logs, err, signature }) => {
        try {
          if (err) return;

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
              const bondingCurve = accountKeys[2];
              const associatedBondingCurve = accountKeys[3]; // dev address
              let virtualSolReserves = 30 * LAMPORTS_PER_SOL;
              let virtualTokenReserves = 1000000000 * 10 ** 6;
              
              if (txn && txn.blockTime && txn.meta) {
                const solSpent =
                  Math.abs(txn.meta.postBalances[0] - txn.meta.preBalances[0]) /
                  LAMPORTS_PER_SOL;
                const maxDevBuyAmount = SniperBotConfig.getMaxDevBuyAmount();

                const price = getCachedSolPrice() * (virtualSolReserves / LAMPORTS_PER_SOL) / (virtualTokenReserves / 10 ** 6);
                virtualTokenReserves -= solSpent * 10 ** 6 / price;
                virtualSolReserves += solSpent * LAMPORTS_PER_SOL;

                const pumpData: PumpData = {
                  bondingCurve,
                  associatedBondingCurve,
                  virtualSolReserves,
                  virtualTokenReserves,
                  price,
                  progress: 0,
                  totalSupply: 1000000000,
                  marketCap: price * 1000000000
                }
                if (
                  maxDevBuyAmount.enabled &&
                  solSpent > maxDevBuyAmount.value
                ) {
                  return;
                }
                let isDuplicated = false;
                if(SniperBotConfig.getBuyConfig().duplicates.enabled === true){
                  isDuplicated = await checkDuplicates(mint.toBase58());
                }else{
                  checkDuplicates(mint.toBase58());
                }
                
                if (isDuplicated) return;
                if (!isRunning() || !isWorkingTime()) {
                  return;
                }
                const created_timestamp = txn.blockTime * 1000;
                console.log(`[ sniper ] 🎯 New token ${mint.toBase58()}`);
                BUY_MORNITOR_CYCLE = SniperBotConfig.getBuyIntervalTime();
                monitorToken(mint.toBase58(), pumpData, user, created_timestamp);
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
