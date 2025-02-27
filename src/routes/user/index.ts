import { Router } from "express";
import { CustomRequest } from "../../middleware/auth";
import User from "../../models/User";
import logger from "../../logs/logger";

const router = Router();

router.get("/profile", async (req: CustomRequest, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password");
    if (!user) {
      logger.warn(`Profile not found for user ID: ${req.user.userId}`);
      return res.status(404).json({ message: "User not found" });
    }

    logger.info(`Profile accessed by user ID: ${req.user.userId}`);
    res.json(user);
  } catch (error: any) {
    logger.error(`Profile fetch error: ${error.message}`);
    res.status(500).json({ message: "Error fetching profile" });
  }
});



export default router;
