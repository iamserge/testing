import { wallet } from "../../config";
import logger from "../../logs/logger";
import { getSolBananceFromWallet } from "../assets/assets";

let balanceCache = 0;
export async function startBalanceMonitor() {
  logger.info("Start monitoring wallet balance...");
  balanceCache = await getSolBananceFromWallet(wallet);
  setInterval(async () => {
    const balance = await getSolBananceFromWallet(wallet);
    balanceCache = balance;
  }, 1 * 60 * 1000); // Check every minute
}

export function getWalletBalanceFromCache(): number {
  return balanceCache;
}

