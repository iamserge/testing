import { VersionedTransaction } from "@solana/web3.js";
import { connection, wallet } from "../../config";
import { ISwapHashResponse, SwapParam } from "../../utils/types";
import { JitoBundleService } from "./jito/jito";
import { isRunning, isWorkingTime, simulateTxn } from "../../utils/utils";
import { raydiumSwap } from "./raydium/raydiumSwap";
import { pumpfunSwap } from "./pumpfun/pumpfunSwap";
import logger from "../../logs/logger";
import { tokenClose } from "./tokenClose";

export async function confirmVtxn(txn: VersionedTransaction) {
  const rawTxn = txn.serialize();
  const jitoBundleInstance = new JitoBundleService();
  const txHash = await jitoBundleInstance.sendTransaction(rawTxn);
  const txRlt = await connection.confirmTransaction(txHash);
  if (txRlt.value.err) return null;
  return { txHash };
}

export const swap = async (
  swapParam: SwapParam
): Promise<ISwapHashResponse | null> => {
  try {
    let vTxn;
    let inAmount = 0; // without decimals
    let outAmount = 0; // without decimals
    let price = 0;

    if(swapParam.isSellAll && swapParam.amount < 0.000_1) {
      
      vTxn = await tokenClose(swapParam.mint, swapParam.amount);
    } else {
      let swapResponse = await pumpfunSwap(swapParam);

      if (swapResponse) {
        vTxn = swapResponse?.vTxn;
        inAmount = swapResponse?.inAmount;
        outAmount = swapResponse?.outAmount;
        price = Number(swapParam.pumpData?.price);
      } else if (!swapParam.is_buy) {
        console.log("- token is in raydium");
        swapResponse = await raydiumSwap(swapParam);
        if (swapResponse) {
          vTxn = swapResponse?.vTxn;
          inAmount = swapResponse?.inAmount;
          outAmount = swapResponse?.outAmount;
          price = Number(swapResponse?.price);
        }else{
          console.log("- failed making raydium swap txn");
        }
      }
    }
    if (!vTxn) return null;
    vTxn.sign([wallet]);
    let flag = false;
    if (swapParam.is_buy && isRunning() && isWorkingTime()) flag = true;
    else if (!swapParam.is_buy) flag = true;
    if (flag) {
      await simulateTxn(vTxn);
      const result = await confirmVtxn(vTxn);
      if (!result) return null;
      const { txHash } = result;
      return { txHash, price, inAmount, outAmount };
    }
    return null;
  } catch (e: any) {
    console.error('- Error while running swap function', e.message);
    return null;
  }
};
