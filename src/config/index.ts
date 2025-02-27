import { Metaplex } from "@metaplex-foundation/js";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

export const config = {
  serverPort: process.env.SERVER_PORT || 5000,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/my-db",
  jwtSecret: process.env.JWT_SECRET || "your-secret-key",
  jwtExpiresIn: "24h",
  apiVersion: process.env.API_VERSION || "v1",

  // Logging configuration
  logPath: "src/logs/logs",
  logLevel: "info",

  // admin crediential
  adminEmail: process.env.ADMIN_EMAIL,
  adminPwd: process.env.ADMIN_PWD,

  update_cycle: 5 * 60 * 1000, // 1 minutes in milliseconds to update all data
  sell_monitor_cycle: 1 * 30 * 1000, // 30 seconds in milliseconds
  lastBlock_Update_cycle: 1 * 1000, // 1 s
};

const SOLANA_RPC_URL: string =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
export const WSS_URL: string =
  process.env.WSS_URL || "ws://api.mainnet-beta.solana.com";

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
export const X_API_KEY: string = process.env.X_API_KEY || "";

export const connection = new Connection(SOLANA_RPC_URL, {
  wsEndpoint: WSS_URL,
});
export const metaplex = new Metaplex(connection);

export const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

export enum START_TXT {
  log = "🧹 Log files swept clean...",
  server = "🚀 Server is running...",
  sniper = "🎯 Sniper service started...",
  db = "🌟 MongoDB connected...",
  sell = "💰 Sell monitor started...",
}

export const USER_EMAILS = [
  "a@bonus.ru",
  "Aspolifellc@gmail.com",
  "didiasc@gmail.com",
  "Pitlzback@gmail.com",
  "ito.inoue.inf23@gmail.com",
  "pleasebugmenot.dev@gmail.com",
  "Pitlzback@gmail.com"
];

export const OPT_EXPIRE_TIME = 5 * 60 * 1000;
export const SMTP_USER = process.env.SMTP_USER;
export const SMTP_KEY = process.env.SMTP_KEY;
export const SMTP_HOST = process.env.SMTP_HOST || "smtp-relay.brevo.com";
export const SMTP_PORT = process.env.SMTP_PORT || 587;