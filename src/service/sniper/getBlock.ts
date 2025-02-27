import { PublicKey } from "@solana/web3.js";
import { config, connection } from "../../config";
import { getSolPrice } from "../../utils/utils";
import logger from "../../logs/logger";

let lastValidBlockhash = "";
let cachedSolPrice = 212; 

// Function to fetch the latest blockhash and cache it
export async function fetchLastValidBlockhash() {
  const tmpSolPrice = await getSolPrice();
  cachedSolPrice = tmpSolPrice === 0 ? cachedSolPrice : tmpSolPrice;
  // if (!isSniping()) return;
  try {
    const { blockhash } = await connection.getLatestBlockhash();
    lastValidBlockhash = blockhash;
  } catch (error:any) {
    logger.error("Error fetching latest blockhash:" + error.message);
  }
}

// Keep fetching the last valid blockhash every 100ms
setInterval(fetchLastValidBlockhash, config.lastBlock_Update_cycle);

export function getLastValidBlockhash(): string {
  return lastValidBlockhash;
}

export const getCachedSolPrice = () => {
  return cachedSolPrice;
};
