import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { metaplex } from "../../config";
import logger from "../../logs/logger";
import { SniperTxns } from "../../models/SniperTxns";
import { IAlertMsg } from "../../utils/types";
import { TOTAL_SUPPLY } from "../../utils/constants";
import { getCurrentUSDMC } from "../../utils/utils";
import { getUnreadAlerts, markAlertAsRead, markAllAlertsAsRead } from "../../service/alarm/alarm";

const router = Router();

router.get("/", async (req, res) => {
  try {
    // tx
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string) || "";
    const startDate = parseInt(req.query.start_date as string);
    const endDate = parseInt(req.query.end_date as string);
    const sortField = (req.query.sort_field as string) || "";
    const sortOrder = (req.query.sort_order as string) || "desc";
    // url =>  /transactions/?limit=10&offset=0&start_date=1736367897317&end_date=1736402400000
    let searchQuery: any = {};
    if (search) {
      searchQuery.$or = [
        { mint: { $regex: search, $options: "i" } },
        { txHash: { $regex: search, $options: "i" } },
        { tokenName: { $regex: search, $options: "i" } },
        { tokenSymbol: { $regex: search, $options: "i" } },
      ];
    }
    if (startDate && endDate) {
      searchQuery.date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }
    let sortOptions: { [key: string]: 1 | -1 } = {};
    sortOptions[sortField] = sortOrder === "desc" ? -1 : 1;
    const totalCnt = await SniperTxns.countDocuments(searchQuery);
    if (!sortField) {
      sortOptions = { date: -1 };
    }
    const paginatedData = await SniperTxns.find(searchQuery)
      .sort(sortOptions)
      .skip(offset)
      .limit(limit);

    const updatedData = await Promise.all(
      paginatedData.map(async (item) => {
        const currentMC_usd = await getCurrentUSDMC(item.mint);
        let cacheData = {
          tokenName: item.tokenName,
          tokenSymbol: item.tokenSymbol,
          tokenImage: item.tokenImage,
          swapMC_usd: item.swapMC_usd,
          buyMC_usd: item.buyMC_usd,
        };
        if (item.tokenName === "UNKNOWN" || item.tokenSymbol === "UNKNOWN") {
          const metaData = await metaplex
            .nfts()
            .findByMint({ mintAddress: new PublicKey(item.mint) });
          cacheData.tokenName = metaData.name;
          cacheData.tokenSymbol = metaData.symbol;
          cacheData.tokenImage = metaData.json?.image || "";
          await SniperTxns.updateMany(
            { mint: item.mint },
            {
              $set: {
                tokenName: cacheData.tokenName,
                tokenSymbol: cacheData.tokenSymbol,
                tokenImage: cacheData.tokenImage,
              },
            }
          );
        }
        if (cacheData.swapMC_usd === 0) {
          cacheData.swapMC_usd = item.swapPrice_usd * TOTAL_SUPPLY;
        }
        if(!cacheData.buyMC_usd) {
          const buyTxn = await SniperTxns.findOne({
            mint: item.mint,
            swap: "BUY",
          });
          cacheData.buyMC_usd = buyTxn?.swapMC_usd || 0;
        }
        return {
          txHash: item.txHash,
          mint: item.mint,
          txTime: item.txTime,
          tokenName: cacheData.tokenName,
          tokenSymbol: cacheData.tokenSymbol,
          tokenImage: cacheData.tokenImage,
          swap: item.swap,
          swapPrice_usd: item.swapPrice_usd,
          swapAmount: item.swapAmount,
          swapAmount_usd: item.swapAmount * item.swapPrice_usd,
          swapFee_usd: item.swapFee_usd,
          swapMC_usd: cacheData.swapMC_usd,
          currentMC_usd: currentMC_usd || item.swapMC_usd,
          swapProfit_usd: item.swapProfit_usd,
          swapProfitPercent_usd: item.swapProfitPercent_usd,
          buyMC_usd: cacheData.buyMC_usd,
          date: item.date,
          dex: item.dex,
        };
      })
    );
    res.json({
      total: totalCnt,
      offset,
      limit,
      sortField,
      sortOrder,
      data: updatedData,
    });
  } catch (error: any) {
    logger.error(`Error fetching tx data: ${error.message}`);
    res.status(500).json({ message: "Error fetching tx data" });
  }
});

router.get("/getall", async (req, res) => {
  try {
    const data = await SniperTxns.find();
    res.json(data);
  } catch (error: any) {
    logger.error(`Error fetching all tx data: ${error.message}`);
    res.status(500).json({ message: "Error fetching all tx data" });
  }
});

router.get("/new-alerts", async (req, res) => {
  try {
    const alerts: IAlertMsg[] = await getUnreadAlerts();
    res.json(alerts);
  } catch (error: any) {
    logger.error(`Error fetching new alert data: ${error.message}`);
    res.status(500).json({ message: "Error fetching new lart data" });
  }
});

router.post("/mark-read", async (req, res) => {
  const { id } = req.body;
  const updatedAlert = await markAlertAsRead(id);
  res.json(updatedAlert);
});

router.post("/mark-all-read", async (req, res) => {
  const result = await markAllAlertsAsRead();
  res.json({ success: true, modifiedCount: result.modifiedCount });
});

export default router;
