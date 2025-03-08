import {
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ISwapTxResponse, SwapParam } from "../../../utils/types";
import { connection, wallet } from "../../../config";
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getCachedSolPrice, getLastValidBlockhash } from "../../sniper/getBlock";
import { JitoAccounts } from "../jito/jito";
import {
  jsonInfo2PoolKeys,
  Liquidity,
  LiquidityPoolKeys,
  Percent,
  Token,
  TokenAmount,
} from "@raydium-io/raydium-sdk";
import { getWalletTokenAccount } from "../../../utils/utils";
import { TOKEN_DECIMALS } from "../../../utils/constants";
import { getPoolKeyMap } from "../../sniper/sellMonitorService";
import { calculateReserves, fetchPoolInfoByMint } from "./utils";
import { formatAmmKeysById } from "./formatAmmByKeyId";
import { BN } from "bn.js";
import { tokenClose } from "../tokenClose";

export const WSOL_TOKEN = new Token(
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  9,
  "WSOL",
  "WSOL"
);
export const raydiumSwap = async (
  swapParam: SwapParam
): Promise<ISwapTxResponse | null> => {
  const { mint, amount, slippage, tip, is_buy } = swapParam;
  const slippageP = new Percent(slippage, 100);
  const MINT_TOKEN = new Token(TOKEN_PROGRAM_ID, mint, TOKEN_DECIMALS);
  const inputToken = is_buy ? WSOL_TOKEN : MINT_TOKEN;
  const outputToken = is_buy ? MINT_TOKEN : WSOL_TOKEN;
  const inDecimal = is_buy ? 9 : TOKEN_DECIMALS;
  const inAmount = Math.floor(amount)
  const inputTokenAmount = new TokenAmount(inputToken, inAmount);
  // -------- pre-action: get pool info --------
  let poolKeys = getPoolKeyMap(mint);
  if (!poolKeys) {
    const poolId = await fetchPoolInfoByMint(mint);
    if (!poolId) {
      return null;
    }
    const targetPoolInfo = await formatAmmKeysById(poolId);
    if (!targetPoolInfo) {
      return null;
    }
    poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys;
  }

  const poolInfo = await calculateReserves(poolKeys);
  const { amountOut, minAmountOut, currentPrice } = Liquidity.computeAmountOut({
    poolKeys: poolKeys,
    poolInfo: poolInfo,
    amountIn: inputTokenAmount,
    currencyOut: outputToken,
    slippage: slippageP,
  });

  let price = 0;
  const decimalsDiff = currentPrice.baseCurrency.decimals - currentPrice.quoteCurrency.decimals;
  if ((currentPrice.baseCurrency as Token).mint.equals(NATIVE_MINT)) {
    price = currentPrice.denominator.mul(new BN(LAMPORTS_PER_SOL)).div(currentPrice.numerator).toNumber() / 10 ** decimalsDiff / LAMPORTS_PER_SOL;
  } else {
    price = currentPrice.numerator.mul(new BN(LAMPORTS_PER_SOL)).div(currentPrice.denominator).toNumber() * 10 ** decimalsDiff / LAMPORTS_PER_SOL;      
  }
  price *=  getCachedSolPrice();


  const _tmpMinAmt = minAmountOut.numerator.mul(new BN(LAMPORTS_PER_SOL)).div(minAmountOut.denominator).toNumber() / LAMPORTS_PER_SOL;
  let wSolReserveAmount = poolKeys.baseMint.equals(NATIVE_MINT) ? poolInfo.baseReserve : poolInfo.quoteReserve;
  wSolReserveAmount = wSolReserveAmount.div(new BN(LAMPORTS_PER_SOL));
  if((wSolReserveAmount.toNumber() <= 0 || _tmpMinAmt < 0.000001) && is_buy === false) {
    const isSellAll = swapParam.isSellAll || false;
    const vTxn = await tokenClose(mint, inAmount, isSellAll);
    const outAmount = amountOut.numerator.mul(new BN(LAMPORTS_PER_SOL)).div(amountOut.denominator).toNumber() / LAMPORTS_PER_SOL;
    if(!vTxn) return null;
    return {
      vTxn: vTxn,
      inAmount: inAmount / 10 ** inDecimal,
      outAmount: outAmount,
      price,
      needsAccountClose: false,
    }
  }
  // console.log("raydium price", price);
  // console.log("got price", price);
  // -------- step 2: create instructions by SDK function --------
  const walletTokenAccounts = await getWalletTokenAccount();
  const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
    connection,
    poolKeys,
    userKeys: {
      tokenAccounts: walletTokenAccounts,
      owner: wallet.publicKey,
    },
    amountIn: inputTokenAmount,
    amountOut: minAmountOut,
    fixedSide: "in",
    makeTxVersion: 0,
  });

  const feeInstructions = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: new PublicKey(JitoAccounts[0]),
    lamports: tip * LAMPORTS_PER_SOL,
  });
  const instructions: TransactionInstruction[] = [];
  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 100000
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 300000
    }),
    ...innerTransactions.flatMap((tx: any) => tx.instructions),
    feeInstructions
  );
  if (swapParam.isSellAll) {
    const splAta = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      wallet.publicKey,
      true
    );
    instructions.push(
      createCloseAccountInstruction(splAta, wallet.publicKey, wallet.publicKey)
    );
  }

  const blockhash = getLastValidBlockhash();
  if (!blockhash) {
    console.error("Failed to retrieve blockhash from cache");
    throw new Error("Failed to retrieve blockhash from cache");
  }
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const outAmount = amountOut.numerator.mul(new BN(LAMPORTS_PER_SOL)).div(amountOut.denominator).toNumber() / LAMPORTS_PER_SOL;

  return {
    vTxn: new VersionedTransaction(messageV0),
    inAmount: inAmount / 10 ** inDecimal,
    outAmount: outAmount,
    price,
    needsAccountClose: false,
  };
};
