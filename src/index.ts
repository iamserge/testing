import express, { Express } from "express";
import mongoose from "mongoose";
import cors from "cors";
import { validateJWT } from "./middleware/auth";
import routes from "./routes";
import logger from "./logs/logger";
import { config, START_TXT, wallet } from "./config";
// import { startDataUpdate } from "./service";
import { sniperService } from "./service/sniper/sniperService";
import { sellMonitorService } from "./service/sniper/sellMonitorService";
import { SniperBotConfig } from "./service/setting/botConfigClass";

const server: Express = express();

server.use(cors());
server.use(express.json());

server.use((req, res, next) => {
  if (
    req.path === `/api/${config.apiVersion}/auth/sendcode` ||
    req.path === `/api/${config.apiVersion}/auth/login` ||
    req.path === `/api/${config.apiVersion}/auth/register` ||
    req.path === `/api/${config.apiVersion}/auth/logout`
  ) {
    return next();
  }
  validateJWT(req, res, next);
});

/********* db **************/
mongoose
  .connect(config.mongoUri)
  .then(() => {
    logger.info(START_TXT.db);
  })
  .catch((error) => {
    logger.critical(`MongoDB connection error: ${error.message}`);
    process.exit(1);
  });

server.use(`/api/${config.apiVersion}`, routes);
server.listen(config.serverPort, async () => {
  // logger.clearLogs();
  logger.info(`${START_TXT.server} ${config.serverPort}`);
  sniperService();
  sellMonitorService();
});

process.on("uncaughtException", (error) => {
  logger.critical(`Uncaught Exception: ${error.message}`);
});
