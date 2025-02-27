import { Router } from "express";
import logger from "../../logs/logger";
import { CustomRequest } from "../../middleware/auth";
import { isRunning, isSniping, isWorkingTime } from "../../utils/utils";
import { SniperBotConfig } from "../../service/setting/botConfigClass";

const router = Router();

router.get("/all", async (req: CustomRequest, res) => {
  try {
    const logs = logger.getAllLogs();
    res.send(logs);
  } catch (error: any) {
    logger.error(`Logs fetch error: ${error.message}`);
    res.status(500).json({ message: "Error fetching Logs" });
  }
});

router.get("/info", async (req: CustomRequest, res) => {
  try {
    const status = {
      msg: "Current Bot Status",
      isSniping: isSniping(),
      isRunning: isRunning(),
      isWorkingTime: isWorkingTime(),
      workingHours: SniperBotConfig.getMainConfig().workingHours,
    };

    res.send(status);
  } catch (error: any) {
    logger.error(`Logs fetch error: ${error.message}`);
    res.status(500).json({ message: "Error fetching Logs" });
  }
});

router.get("/remove", async (req: CustomRequest, res) => {
  try {
    logger.clearLogs();
    res.status(200).json({ message: "Logs removed successfully" });
  } catch (error: any) {
    logger.error(`Logs remove error: ${error.message}`);
    res.status(500).json({ message: "Error removing Logs" });
  }
});

export default router;
