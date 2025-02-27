import {
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ISwapTxResponse, SwapParam } from "../../../utils/types";
import { connection, wallet } from "../../../config";
import {
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
import { fetchPoolInfoByMint } from "./utils";
import { formatAmmKeysById } from "./formatAmmByKeyId";

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
  const { amountOut, minAmountOut, currentPrice } = Liquidity.computeAmountOut({
    poolKeys: poolKeys,
    poolInfo: await Liquidity.fetchInfo({ connection, poolKeys }),
    amountIn: inputTokenAmount,
    currencyOut: outputToken,
    slippage: slippageP,
  });

  let price = 0;
  const decimalsDiff =
      currentPrice.baseCurrency.decimals - currentPrice.quoteCurrency.decimals;
  if ((currentPrice.baseCurrency as Token).mint.equals(NATIVE_MINT)) {
    price =
      Number(currentPrice.denominator) /
      Number(currentPrice.numerator) /
      10 ** decimalsDiff;
  } else {
    price =
      (Number(currentPrice.numerator) / Number(currentPrice.denominator)) *
      10 ** decimalsDiff;
  }
  price *=  getCachedSolPrice();
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

  console.log("made a raydium swap txn", mint);

  return {
    vTxn: new VersionedTransaction(messageV0),
    inAmount: inAmount / 10 ** inDecimal,
    outAmount: Number(
      Number(amountOut.numerator) /
        Number(amountOut.denominator) /
        10 ** inDecimal
    ),
    price,
  };
};
