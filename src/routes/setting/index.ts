import { Router } from "express";
// import { BotConfigService } from "../../service/setting/botConfigService";
import logger from "../../logs/logger";
import { SniperBotConfig } from "../../service/setting/botConfigClass";
import { isSniping } from "../../utils/utils";

const router = Router();

// Get configuration
router.get("/main", async (req, res) => {
  try {
    const config = SniperBotConfig.getMainConfig();

    const data = {
      ...config,
      isSniping: isSniping(),
    };
    res.json(data);
  } catch (error: any) {
    logger.error(`Config fetch error: ${error.message}`);
    res.status(500).json({ message: "Error fetching configuration" });
  }
});

router.post("/main", async (req, res) => {
  try {
    const config = req.body;
    await SniperBotConfig.setMainConfig(config);
    res.status(200).json({ message: "Configuration updated successfully" });
    console.log(SniperBotConfig.getMainConfig());
  } catch (error: any) {
    logger.error(`Config update error: ${error.message}`);
    res.status(500).json({ message: "Error updating configuration" });
  }
});

router.get("/buy", async (req, res) => {
  try {
    const config = SniperBotConfig.getBuyConfig();
    res.json(config);
  } catch (error: any) {
    logger.error(`Config fetch error: ${error.message}`);
    res.status(500).json({ message: "Error fetching configuration" });
  }
});

router.post("/buy", async (req, res) => {
  try {
    const config = req.body;
    await SniperBotConfig.setBuyConfig(config);
    console.log(SniperBotConfig.getBuyConfig());
    res.json({ message: "Configuration updated successfully" });
  } catch (error: any) {
    logger.error(`Config update error: ${error.message}`);
    res.status(500).json({ message: "Error updating configuration" });
  }
});

router.get("/sell", async (req, res) => {
  try {
    const config = SniperBotConfig.getSellConfig();
    res.json(config);
  } catch (error: any) {
    logger.error(`Config fetch error: ${error.message}`);
    res.status(500).json({ message: "Error fetching configuration" });
  }
});

router.post("/sell", async (req, res) => {
  try {
    const config = req.body;
    await SniperBotConfig.setSellConfig(config);
    res.json({ message: "Configuration updated successfully" });
  } catch (error: any) {
    logger.error(`Config update error: ${error.message}`);
    res.status(500).json({ message: "Error updating configuration" });
  }
});

// Get Xscore stats
// router.get("/xscore-stats", async (req: CustomRequest, res) => {
//   try {
//     const count = await XScore.countDocuments();
//     const stats = {
//       totalRecords: count,
//       lastUpdated: new Date(),
//     };

//     logger.info(`XScore stats accessed: ${count} records`);
//     res.json(stats);
//   } catch (error: any) {
//     logger.error(`Error fetching XScore stats: ${error.message}`);
//     res.status(500).json({ message: "Error fetching XScore stats" });
//   }
// });

export default router;
