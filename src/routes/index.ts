import { Router } from "express";
import authRoutes from "./auth";
import tokenRoutes from "./token";
import settingRoutes from "./setting";
import assetsRoutes from "./assets";
import transactionRoutes from "./transactions";
import logs from "./logs";

const router = Router();

router.use("/auth", authRoutes);
router.use("/token", tokenRoutes);
router.use("/setting", settingRoutes);
router.use("/assets", assetsRoutes);
router.use("/transactions", transactionRoutes);
router.use("/logs", logs);

export default router;
