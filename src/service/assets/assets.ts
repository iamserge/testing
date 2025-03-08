import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { AccountLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connection, metaplex, wallet } from "../../config";
import { SniperTxns } from "../../models/SniperTxns";
import { TokenAnalysis } from "./tokenAnalysisService";
import { getPumpTokenPriceUSD } from "../pumpfun/pumpfun";
import { ITokenAnalysisData } from "../../utils/types";
import { TOTAL_SUPPLY } from "../../utils/constants";
import logger from "../../logs/logger";

export async function getWalletTokens(walletAddress: PublicKey) {
  try {
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      walletAddress,
      { programId: TOKEN_PROGRAM_ID }
    );
  
    const tokens = tokenAccounts.value.map((ta) => {
      const accountData = AccountLayout.decode(ta.account.data);
      return {
        mint: accountData.mint.toBase58(),
        amount: Number(accountData.amount),
      };
    });
    return tokens;
  } catch (error) {
    logger.error("getWalletTokens error" + error);
    return [];
  }
}

/*
│ (index) │ mint                                           │ amount     │
├─────────┼────────────────────────────────────────────────┼────────────┤
│ 0       │ 'D3cyNBRdYpKwbXUjaf37v7sDC3sRBxgy1rpyek5qpump' │ 357.666547 │
│ 1       │ '4QFtsuiTQHug2b5ZxsTUUrn1N1nf63s1j2157oeypump' │ 357.666547 │
*/

export const getSolBananceFromWallet = async (wallet: Keypair) => {
  try {
    const walletAddress = wallet.publicKey.toBase58();
    const pubKey = new PublicKey(walletAddress);
    const solBalance = await connection.getBalance(pubKey);
    return solBalance / LAMPORTS_PER_SOL;
  } catch (error) {
    logger.error("getSolBananceFromWallet error" + error);
    return 0;
  }
};

export const getTotalTokenDataforAssets = async (): Promise<
  ITokenAnalysisData[]
> => {
  const tokens = await getWalletTokens(wallet.publicKey); // mint, amount
  if (!tokens) return [];
  const rlt = await Promise.all(
    tokens.map(async (token) => {
      try {
        return await getTokenDataforAssets(token.mint);
      } catch (error) {
        logger.error("getTokenDataforAssets fuction: " + token.mint + error);
        return null;
      }
    })
  ).then((results): ITokenAnalysisData[] =>
    results.filter((item): item is ITokenAnalysisData => item !== null)
  );

  return rlt;
};

export const getTokenDataforAssets = async (
  mint: string
): Promise<ITokenAnalysisData | null> => {
  const txCount = await SniperTxns.countDocuments({ mint: mint });
  if (txCount === 0) return null; // there is no transaction for this mint

  const tmp = await getPumpTokenPriceUSD(mint);
  let cacheData: ITokenAnalysisData = TokenAnalysis.getTokenAnalysis(mint) || {
    mint: mint,
    tokenName: "",
    tokenSymbol: "",
    tokenImage: "",
    tokenCreateTime: Date.now(),
    currentAmount: 0,
    realisedProfit: 0,
    unRealizedProfit: 0,
    totalFee: 0,
    sellingStep: 1,
    pnl: { profit_usd: 0, percent: 0 },
    holding: { value_usd: 0 },
  };
  let currentPrice_usd = 0;
  // if current amount of token is 0, this current price is the last sell price
  let lastSellTxn;
  if (cacheData.currentAmount === 0) {
    lastSellTxn = await SniperTxns.findOne({
      mint: mint,
      swap: "SELL",
    }).sort({ txTime: -1 });
    if(!lastSellTxn) currentPrice_usd = tmp?.price;
    else currentPrice_usd = Number(lastSellTxn?.swapPrice_usd || 0);
  } else {
    // @ts-ignore
    currentPrice_usd = tmp?.price || 0; //
  }
  // @ts-ignore
  const dex = (cacheData.currentAmount === 0 ? lastSellTxn?.dex : tmp?.isRaydium ? "Raydium" : "Pumpfun") || "Pumpfun";

  if (
    cacheData.tokenName === "UNKNOWN" ||
    cacheData.tokenSymbol === "UNKNOWN" ||
    cacheData.investedMC_usd === 0
  ) {
    const metaPlexData = await metaplex
      .nfts()
      .findByMint({ mintAddress: new PublicKey(mint) });
    cacheData.tokenName = metaPlexData.name;
    cacheData.tokenSymbol = metaPlexData.symbol;
    cacheData.tokenImage = metaPlexData.json?.image;
    cacheData.investedMC_usd =
      (cacheData.investedPrice_usd || 0) * TOTAL_SUPPLY;

    await SniperTxns.updateMany(
      { mint: mint },
      {
        $set: {
          tokenName: cacheData.tokenName,
          tokenSymbol: cacheData.tokenSymbol,
          tokenImage: cacheData.tokenImage,
          swapMC_usd: cacheData.investedMC_usd,
        },
      }
    );
  }
  // const cSupply = Number(metadata.mint.supply.basisPoints || 0) / 10 ** TOKEN_DECIMALS;
  const real_profit = Number(cacheData.realisedProfit);
  const unreal_profit = Number(
    (currentPrice_usd - (cacheData.investedPrice_usd || currentPrice_usd)) *
      (cacheData.currentAmount || 0)
  );
  const holdingValue_usd =  Number(cacheData.currentAmount || 0) * Number(currentPrice_usd || 0);
  // console.log(holdingValue_usd, cacheData.currentAmount, currentPrice_usd);
  const sellTxns = await SniperTxns.find({ mint: mint, swap: "SELL" });
  let sellAmount_usd = 0;
  for (const tx of sellTxns) {
    sellAmount_usd += tx.swapPrice_usd * tx.swapAmount;
  }
  const currentPnl_usd =
    sellAmount_usd + holdingValue_usd - Number(cacheData.investedAmount_usd || 0);
  return {
    mint: mint,
    tokenName: cacheData?.tokenName,
    tokenSymbol: cacheData?.tokenName,
    tokenImage: cacheData?.tokenImage,
    tokenCreateTime: cacheData?.tokenCreateTime,

    investedAmount: cacheData?.investedAmount,
    investedPrice_usd: cacheData?.investedPrice_usd,
    investedMC_usd: cacheData?.investedMC_usd,
    investedAmount_usd: cacheData?.investedAmount_usd,

    currentAmount: cacheData?.currentAmount,
    currentPrice_usd: currentPrice_usd,
    currentMC_usd: currentPrice_usd * TOTAL_SUPPLY,

    pnl: {
      profit_usd: Number(currentPnl_usd),
      percent: Number(
        (currentPrice_usd / (cacheData.investedPrice_usd || currentPrice_usd) -
          1) *
          100
      ),
    },
    holding: {
      value_usd: holdingValue_usd
    },
    sellingStep: Math.max(txCount - 1, 0) || 0,
    dex: dex,
    realisedProfit: real_profit,
    unRealizedProfit: unreal_profit,
    revenue: real_profit + unreal_profit,
    totalFee: cacheData.totalFee,
  };
};
export const getCalculatedTableData = (tokens: ITokenAnalysisData[]) => {
  if (!tokens || tokens.length === 0)
    return {
      // currentBalance: 0,
      totalProfit: 0,
      realProfit: 0,
      unRealProfit: 0,
      totalInvested: 0,
      totalTickers: 0,
      successTickers: 0,
      totalFeePaid: 0,
      currentPercent: 0,
    };
  // let currentBalance = 0;
  let totalProfit = 0;
  let realProfit = 0;

  let unRealProfit = 0;
  let totalInvested = 0;
  let totalTickers = tokens.length;
  let successTickers = 0;
  let totalFeePaid = 0;
  let currentPercent = 0;
  let tmpC = 0;
  let tmpI = 0;
  for (const token of tokens) {
    // currentBalance += token.holding.value_usd || 0;
    realProfit += token.realisedProfit || 0;
    unRealProfit += token.unRealizedProfit || 0;
    totalInvested += token.investedAmount_usd || 0;
    successTickers += (token.realisedProfit || 0) > 0 ? 1 : 0;
    totalFeePaid += token.totalFee || 0;
    tmpC += (token.currentPrice_usd || 0) * (token.currentAmount || 0);
    tmpI += (token.investedPrice_usd || 0) * (token.currentAmount || 0);
  }
  currentPercent = (tmpC / tmpI - 1) * 100;
  totalProfit = realProfit + unRealProfit;
  return {
    // currentBalance,
    totalProfit,
    realProfit,
    unRealProfit,
    totalInvested,
    totalTickers,
    successTickers,
    totalFeePaid,
    currentPercent,
  };
};

/*
              formula for calculating
      1. Total invested = Buy price * Buy amount
      2. Revenue = Realized Profit + unRealized Profit
      3. Realized Profit = Sum of all txn gain $ = 537 + 287 + 43.3 + 21.6 = 888.9
      4. Unrealized Profit = (current price - buy price) * current token amount
      5. Current price
      - if current amount is 0, this is last sell swap price: 0.0000_175
      - else this shows current token price
      6. MC
      - if current amount is 0, this shows last sell swap mc
      - else current mc
      7. Buy price
      8. $ = current price * current amount
        current amount
      9. This is mc when I bought the token, so in token detail page, all of buy MCs are same
      10. token price when txn is happend
      11. token swap amount
      12. token swap amount * token swap price

      1. Side Mc is the mc when txn is happened.
      2. Buy Mc is the mc when I bought the token.
      3. This is current mc.
      4. This is token swap amount.
      5. Total = swap price * token amount
      6. Swap Txn Gain/Loss = (swap price - buy price) * swap amount
      7. Percent = (swap price / buy price) * 100 - 100
*/
