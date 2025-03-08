import express, { Express } from "express";
import mongoose from "mongoose";
import cors from "cors";
import { validateJWT } from "./middleware/auth";
import routes from "./routes";
import logger from "./logs/logger";
import { config, START_TXT, wallet } from "./config";
import { sniperService } from "./service/sniper/sniperService";
import { sellMonitorService } from "./service/sniper/sellMonitorService";
import { createServer } from "http";
import { startBalanceMonitor } from "./service/sniper/getWalletBalance";
import { WssMonitorService } from "./service/sniper/wssMonitorService";

// Configuration flag to determine which sell monitoring approach to use
export const USE_WSS = true;

const server: Express = express();

server.use(cors());
server.use(express.json());
const httpServer = createServer(server);

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

server.use(`/api/${config.apiVersion}`, routes);

const startServer = () => {
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
    
  httpServer.listen(config.serverPort, async () => {
    logger.clearLogs();
    logger.info(`${START_TXT.server} ${config.serverPort}`);
    
    // Start the wallet balance monitor
    startBalanceMonitor();
    
    // Always start the sniper service (for buying tokens)
    sniperService();
    
    // Choose the appropriate sell monitoring service based on configuration
    if (USE_WSS) {
      logger.info("🌐 Using WebSocket-based token monitoring service");
      WssMonitorService.initialize();
    } else {
      logger.info("⏱️ Using interval-based token monitoring service");
      sellMonitorService();
    }
  });
};

// Handle uncaught exceptions and restart server gracefully
process.on("uncaughtException", async (error) => {
  logger.critical(`Uncaught Exception: ${error.message}`);

  // Stop WebSocket monitoring if active
  if (USE_WSS) {
    WssMonitorService.stopAllMonitoring();
  }

  await new Promise((resolve) => httpServer.close(resolve));

  // Close MongoDB connection
  await mongoose.connection.close();

  logger.info("All connections closed. Restarting server...");

  // Restart server components directly
  startServer();
});

// Graceful shutdown on SIGTERM
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  // Stop WebSocket monitoring if active
  if (USE_WSS) {
    WssMonitorService.stopAllMonitoring();
  }
  
  await new Promise((resolve) => httpServer.close(resolve));
  await mongoose.connection.close();
  process.exit(0);
});

// Graceful shutdown on SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  
  // Stop WebSocket monitoring if active
  if (USE_WSS) {
    WssMonitorService.stopAllMonitoring();
  }
  
  await new Promise((resolve) => httpServer.close(resolve));
  await mongoose.connection.close();
  process.exit(0);
});

startServer();