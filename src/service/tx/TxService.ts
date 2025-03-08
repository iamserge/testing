import { IAlertMsg, ITxntmpData } from "../../utils/types";
import { SniperTxns } from "../../models/SniperTxns";
import logger from "../../logs/logger";
import { TokenAnalysis } from "../assets/tokenAnalysisService";
import { TOTAL_SUPPLY } from "../../utils/constants";
import { sniperService } from "../sniper/sniperService";
import { createAlert } from "../alarm/alarm";
import { IToken, DBTokenList } from "../../models/TokenList";
// import { io } from "../..";

// Get all transactions
export const getAllTransactions = async () => {
  return await SniperTxns.find().sort({ date: -1 });
};

// Get transactions by wallet
export const getTransactionsByCA = async (mint: string) => {
  try {
    const transactions = await SniperTxns.aggregate([
      { $match: { mint: mint, swap: "BUY" } },
      { $sort: { date: -1 } },
    ]);
    return (
      transactions[0] || {
        tokenName: "",
        tokenSymbol: "",
        tokenImage: "",
        txTime: 0,
        swapMC_usd: 0,
        total_supply: 0,
      }
    );
  } catch (error) {
    logger.error("getTransactionsByCA error" + error);
    return [];
  }
};

// Get transactions by type (BUY/SELL)
export const getTransactionsByType = async (swap: "BUY" | "SELL") => {
  return await SniperTxns.find({ swap }).sort({ date: -1 });
};

export async function fetchTokenData(mint: string): Promise<any> {
  try {
    
    const buyTxn = await SniperTxns.findOne({ mint, swap: "BUY" });
    if (buyTxn) {
      return {
        name: buyTxn.tokenName,
        symbol: buyTxn.tokenSymbol,
        image_uri: buyTxn.tokenImage,
        usd_market_cap: buyTxn.swapMC_usd,
        buyMC_usd: buyTxn.swapMC_usd,
      };
    }
    const tmpdata = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
    const data = await tmpdata.json();
    
    const tokenData = await DBTokenList.findOne({ mint });
    if (!data.name || !data.symbol || !data.usd_market_cap) {
      return {
        name: "UNKNOWN",
        symbol: "UNKNOWN",
        image_uri: "UNKNOWN",
        usd_market_cap: 0,
        buyMC_usd: 0,
      };
    } 
    return {
      name: tokenData?.tokenName,
      symbol: tokenData?.tokenSymbol,
      image_uri: tokenData?.tokenImage,
      usd_market_cap: 0,
      buyMC_usd: 0,
    };
  } catch (error) {
    return {
      name: "UNKNOWN",
      symbol: "UNKNOWN",
      image_uri: "",
      usd_market_cap: 0,
    };
  }
}

export const saveTXonDB = async (save_data: ITxntmpData) => {
  const {
    isAlert,
    txHash,
    mint,
    swap,
    swapPrice_usd,
    swapAmount,
    swapFee_usd,
    swapProfit_usd,
    swapProfitPercent_usd,
    dex,
  } = save_data; //

  try {
    const data = await fetchTokenData(mint);
    const tokenName = data.name || "UNKNOWN";
    const tokenSymbol = data.symbol || "UNKNOWN";
    const tokenImage = data.image_uri || "UNKNOWN";
    const buyMC_usd = data.buyMC_usd || 0; // this one is mc when swap, buy=swap_mc, sell-buy_mc

    const newTransaction = new SniperTxns({
      txHash: txHash,
      mint: mint,
      txTime: Date.now(),
      tokenName: tokenName,
      tokenSymbol: tokenSymbol,
      tokenImage: tokenImage,
      swap: swap,
      swapPrice_usd: Number(swapPrice_usd),
      swapAmount: Number(swapAmount),
      swapFee_usd: Number(swapFee_usd),
      swapMC_usd: Number(swapPrice_usd * TOTAL_SUPPLY),
      swapProfit_usd: Number(swapProfit_usd),
      swapProfitPercent_usd: Number(swapProfitPercent_usd),
      buyMC_usd: Number(buyMC_usd),
      dex: dex,
    });

    await newTransaction.save();
    TokenAnalysis.updateCacheFromTransaction(newTransaction);

    // if(swap === "BUY") {
    //   try {
    //     const tokenData: Partial<IToken> = {
    //       mint: mint,
    //       tokenName: tokenName.toString(),
    //       tokenSymbol: tokenSymbol.toString(),
    //       tokenImage: tokenImage.toString(),
    //       saveTime: Date.now()
    //     };
    
    //     const newToken = new DBTokenList(tokenData);
    //     await newToken.save();
    //     logger.info(`New token saved: ${tokenSymbol}`);
    //   } catch (error:any) {
    //     logger.error(`Failed to save token: ${error.message}`);
    //   }
    // }

    if (isAlert) {
      try {
        const alertData: IAlertMsg = {
          imageUrl: tokenImage,
          title: tokenName,
          content: "You just sold out this token.",
          link: mint,
          time: Date.now(),
          isRead: false,
        };
        await createAlert(alertData);
      } catch (error) {
        console.log("Error saving alert on db: " + error);
      }
    }
  } catch (error) {
    console.log("Error saving transaction on db: " + error);
  }
};
