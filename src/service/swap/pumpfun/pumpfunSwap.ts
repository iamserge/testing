import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import { JitoAccounts } from "../jito/jito";
import { getPumpData } from "../../pumpfun/pumpfun";
import { bufferFromUInt64 } from "../../../utils/utils";
import { connection, wallet } from "../../../config";
import { BuyInsParam, ISwapTxResponse, SwapParam } from "../../../utils/types";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@raydium-io/raydium-sdk";
import {
  EVENT_AUTHORITY,
  GLOBAL,
  PUMP_FEE_RECIPIENT,
  PUMP_FUN_PROGRAM,
  RENT,
  TOKEN_DECIMALS,
} from "../../../utils/constants";
import { getLastValidBlockhash } from "../../sniper/getBlock";

export const pumpfunSwap = async (
  swapParam: SwapParam
): Promise<ISwapTxResponse | null> => {
  try {
    const { mint, amount, slippage, tip, is_buy, pumpData } = swapParam;
    const pumpTokenData = swapParam.pumpData;
    if (!pumpTokenData) {
      return null;
    }
    const slippageValue = slippage / 100;
    const amountInLamports = is_buy
      ? Math.floor(amount * LAMPORTS_PER_SOL)
      : Math.floor(amount);

    const solAta = spl.getAssociatedTokenAddressSync(
      spl.NATIVE_MINT,
      wallet.publicKey,
      true
    );
    const splAta = spl.getAssociatedTokenAddressSync(
      new PublicKey(mint),
      wallet.publicKey,
      true
    );

    const keys = [
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      {
        pubkey: pumpTokenData?.bondingCurve,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: pumpTokenData?.associatedBondingCurve,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: splAta, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: is_buy ? TOKEN_PROGRAM_ID : ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: is_buy ? RENT : TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
    ];

    let data: Buffer;
    let tokenOut;
    let minSolOutput;
    if (is_buy) {
      tokenOut = Math.floor(
        (amountInLamports * pumpTokenData.virtualTokenReserves) /
          pumpTokenData.virtualSolReserves
      );
      const solInWithSlippage = amount * (1 + slippageValue);
      const maxSolCost = Math.floor(solInWithSlippage * LAMPORTS_PER_SOL);

      data = Buffer.concat([
        bufferFromUInt64("16927863322537952870"),
        bufferFromUInt64(tokenOut),
        bufferFromUInt64(maxSolCost),
      ]);
    } else {
      minSolOutput = Math.floor(
        (amountInLamports *
          (1 - slippageValue) *
          pumpTokenData.virtualSolReserves) /
          pumpTokenData.virtualTokenReserves
      );
      data = Buffer.concat([
        bufferFromUInt64("12502976635542562355"),
        bufferFromUInt64(amountInLamports),
        bufferFromUInt64(minSolOutput),
      ]);
    }

    const pumpInstruction = new TransactionInstruction({
      keys,
      programId: PUMP_FUN_PROGRAM,
      data,
    });

    const instructions: TransactionInstruction[] = is_buy
      ? [
          spl.createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            solAta,
            wallet.publicKey,
            spl.NATIVE_MINT
          ),
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: solAta,
            lamports: amountInLamports,
          }),
          spl.createSyncNativeInstruction(solAta, TOKEN_PROGRAM_ID),
          spl.createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            splAta,
            wallet.publicKey,
            new PublicKey(mint)
          ),
          pumpInstruction,
          spl.createCloseAccountInstruction(
            solAta,
            wallet.publicKey,
            wallet.publicKey
          ),
        ]
      : [
          spl.createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            splAta,
            wallet.publicKey,
            new PublicKey(mint)
          ),
          pumpInstruction,
        ];
    const feeInstructions = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new PublicKey(JitoAccounts[1]),
      lamports: tip * LAMPORTS_PER_SOL,
    });
    instructions.push(feeInstructions);

    if (swapParam.isSellAll)
      instructions.push(
        spl.createCloseAccountInstruction(
          splAta,
          wallet.publicKey,
          wallet.publicKey
        )
      );
    const blockhash = getLastValidBlockhash();

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    // return new VersionedTransaction(messageV0);
    const decimal = is_buy ? 10 ** TOKEN_DECIMALS : LAMPORTS_PER_SOL;
    return {
      vTxn: new VersionedTransaction(messageV0),
      inAmount: amount,
      outAmount: is_buy
        ? Number(tokenOut) / decimal
        : Number(minSolOutput) / decimal,
    };
  } catch (error) {
    return null;
  }
};

export function getBuyInstruction(buyParam: BuyInsParam) {
  const { mint, owner, bondingCurve, associatedBondingCurve, maxSol, splOut } =
    buyParam;

  // Get associated token address for the mint
  const tokenATA = spl.getAssociatedTokenAddressSync(mint, owner, true);

  // Create instruction to create the associated token account if it doesn't exist
  const createATAInstruction =
    spl.createAssociatedTokenAccountIdempotentInstruction(
      owner,
      tokenATA,
      owner,
      mint
    );

  // Keys for the transaction
  const buyKeys = [
    { pubkey: GLOBAL, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: tokenATA, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: spl.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: RENT, isSigner: false, isWritable: false },
    { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
  ];

  // Data for the transaction
  const buyData = Buffer.concat([
    bufferFromUInt64("16927863322537952870"), // Some ID (as string)
    bufferFromUInt64(splOut), // SPL amount out
    bufferFromUInt64(maxSol), // Max SOL
  ]);

  // Create the buy instruction
  const buyInstruction = new TransactionInstruction({
    keys: buyKeys,
    programId: PUMP_FUN_PROGRAM,
    data: buyData,
  });

  return [createATAInstruction, buyInstruction];
}
