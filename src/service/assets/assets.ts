import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { connection, metaplex, wallet } from "../../config";
import { AccountLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SniperTxns } from "../../models/SniperTxns";
import { getPumpTokenPriceUSD } from "../pumpfun/pumpfun";
import logger from "../../logs/logger";
import { ITokenAnalysisData } from "../../utils/types";
import { TokenAnalysis } from "./tokenAnalysisService";
import { TOTAL_SUPPLY } from "../../utils/constants";

export async function getWalletTokens(walletAddress: PublicKey) {
  const tokenAccounts = await connection.getTokenAccountsByOwner(
    walletAddress,
    {
      programId: TOKEN_PROGRAM_ID,
    }
  );

  const tokens = tokenAccounts.value.map((ta) => {
    const accountData = AccountLayout.decode(ta.account.data);
    return {
      mint: accountData.mint.toBase58(),
      amount: Number(accountData.amount),
    };
  });
  return tokens;
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
  // const rlt = await Promise.all(
  //   tokens.map((token) => getTokenDataforAssets(token.mint))
  // );
  // let rlt = [];
  // for (const token of tokens) {
  //   try {
  //     const tmp = await getTokenDataforAssets(token.mint);
  //     rlt.push(tmp);  
  //   } catch (error) {
  //     logger.error("---------- error" + token.mint + error);
  //   }
  // }
  const rlt = await Promise.all(
    tokens.map(async (token) => {
      try {
        return await getTokenDataforAssets(token.mint);
      } catch (error) {
        logger.error("---------- error" + token.mint + error);
        return null;
      }
    })
  ).then((results): ITokenAnalysisData[] => results.filter((item): item is ITokenAnalysisData => item !== null));
  
  return rlt;
  
};

export const getTokenDataforAssets = async (
  mint: string
): Promise<ITokenAnalysisData> => {
  const allPromises = [
    // getMetadataFromMint(mint),
    getPumpTokenPriceUSD(mint),
    SniperTxns.countDocuments({ mint: mint }),
  ];
  const results = await Promise.all(allPromises);
  // const metadata: any = results[0];/
  const tmp = results[0];

  const txCount = Number(results[1]) || 0;
  
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
  if(cacheData.currentAmount === 0) {
    const lastSellTxn = await SniperTxns.findOne({ mint: mint, swap: "SELL" }).sort({ txTime: -1 });
    currentPrice_usd = lastSellTxn?.swapPrice_usd || 0;
  }
  // @ts-ignore
  else currentPrice_usd = tmp?.price || 0; //

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
    (currentPrice_usd - (cacheData.investedPrice_usd || currentPrice_usd)) * (cacheData.currentAmount || 0)
  );
  const sellTxns = await SniperTxns.find({ mint: mint, swap: "SELL" });
  let sellAmount_usd = 0;
  for (const tx of sellTxns) {
    sellAmount_usd += tx.swapPrice_usd * tx.swapAmount;
  }
  const currentPnl_usd =
    sellAmount_usd + Number(cacheData.currentAmount || 0) * Number(cacheData.currentPrice_usd || 0) - Number(cacheData.investedAmount_usd || 0);
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

    // fdv: currentPrice_usd * cSupply,

    pnl: {
      profit_usd: Number(currentPnl_usd),
      percent: Number( (currentPrice_usd / (cacheData.investedPrice_usd || currentPrice_usd) - 1) * 100 ),
    },
    holding: {
      value_usd: Number(currentPrice_usd * (cacheData.currentAmount || 0)),
    },
    sellingStep: Math.max(txCount - 1, 0) || 0,
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
    cp: current price
    ip: invested price

    cm: current market cap
    im: market cap when I swap


    1: SUM (cp * current tokenAmount)
    2: SUM (cp) / SUM (ip) * 100 - 100
    3: SUM [ (cp - ip) * current tokenAmount ] = unreal profit
    4: real profit + unreal profit
    5: SUM ( all txn profit )
    6: SUM [ (cp - ip) * current tokenAmount ]
    7: SUM [ ip($) * invested tokenAmount ]
    8: Total Number of token
    9: Total Number of token that we got profit through all txns of token
    10: SUM [ all txn fee($) ]
    11: (cp - ip) * current tokenAmount
    12: (cp / ip) * 100
*/
