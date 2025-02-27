import { PublicKey } from "@solana/web3.js";
import { connection, metaplex } from "../../config";
import {
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { calculateTotalPercentage } from "../../utils/utils";
import logger from "../../logs/logger";

/*
const getDEVstateFromAmount2String = (value: number) => {
  if (value === 0) return "Sell All";
  if (value < 1) return "Sell";
  else return "Buy";
};

async function getDevState(mint: PublicKey, owner: PublicKey) {
  try {
    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const balance = await connection.getTokenAccountBalance(ata);
    return getDEVstateFromAmount2String(Number(balance.value.uiAmount));
  } catch (e) {
    return getDEVstateFromAmount2String(0);
  }
}
*/
export async function getMintDetails(mint: string): Promise<any> {
  const tokenPublicKey = new PublicKey(mint);
  const mintInfo = await getMint(connection, tokenPublicKey);

  const supply = Number(mintInfo.supply);

  const allAccounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: 165 }, // Size of token account
      { memcmp: { offset: 0, bytes: mint } }, // Filter for token mint
    ],
  });

  const holdersCount = allAccounts.length;
  const holders = allAccounts
    .map((accountInfo: any) => {
      const data = accountInfo.account.data;
      const amount = Number(data.readBigUInt64LE(64));
      const percentage = (amount / supply) * 100;

      return {
        amount,
        percentage,
      };
    })
    .filter((holder: any) => holder !== null);

  holders.sort((a: any, b: any) => b.amount - a.amount);

  const top10 = holders.slice(1, 10);
  const top10HP = calculateTotalPercentage(top10);
  return { mintInfo, top10HP, holdersCount };
}

export const getMetadataFromMint = async (mint: string) => {
  try {
    const mintAddress = new PublicKey(mint);
    const metadata = await metaplex.nfts().findByMint({ mintAddress });
    return metadata;
    // {
    //   address: PublicKey [PublicKey(CKZth...VBxypump)] {
    //     _bn: <BN: a83233...80322f>
    //   },
    //   mintAuthority: null,
    //   supply: 999999964233335n,
    //   decimals: 6,
    //   isInitialized: true,
    //   freezeAuthority: null,
    //   tlvData: <Buffer >
    // }
  } catch (error: any) {
    logger.error("getMetadataFromMint error" + error.message);
  }
};

export const extractTwitterUsername = (twitterUrl: string): string => {
  if (!twitterUrl.includes("/")) {
    return twitterUrl;
  }
  const cleanUrl = twitterUrl.replace(/^(https?:\/\/)?(www\.)?/, "");
  const urlParts = cleanUrl.split("/");
  return (
    urlParts.find(
      (part) => part !== "x.com" && part !== "twitter.com" && part.length > 0
    ) || ""
  );
};

// export const getXScore = async (acc: any) => {
//   try {
//     // let value = 0;
//     // return value;
//     // // If no twitter handle, return 0
//     if (!acc.twitter) {
//       return 0;
//     }

//     // // Check if score exists in DB
//     // const existingScore = await XScore.findOne({ mint: acc.mint });

//     // // Check if we need to fetch new score (if doesn't exist or older than 30 days)
//     // const shouldFetchNew =
//     //   !existingScore ||
//     //   Date.now() - existingScore.timestamp.getTime() >
//     //     config.xScore_Update_cycle;

//     // if (!shouldFetchNew) {
//     //   return existingScore.xScore;
//     // }

//     const userName = extractTwitterUsername(acc.twitter);
//     const headers = {
//       Accept: "application/json",
//       ApiKey: X_API_KEY,
//     };
//     const response = await fetch(
//       `https://api.tweetscout.io/v2/score/${userName}`,
//       {
//         method: "GET",
//         headers: headers,
//       }
//     );

//     const data = await response.json();
//     let score = 0;
//     if (data.score) score = data.score;
//     else score = 0;
//     // Save or update score in DB
//     // await XScore.findOneAndUpdate(
//     //   { mint: acc.mint },
//     //   {
//     //     mint: acc.mint,
//     //     xScore: score,
//     //     userName: userName,
//     //     timestamp: new Date(),
//     //   },
//     //   { upsert: true, new: true }
//     // );
//     return score;
//   } catch (error) {
//     logger.error(`Error in getXScore for mint ${acc.mint}: ${error}`);
//     return 0;
//   }
// };
/*
export const updateDataProcess = async (data: any[]) => {
  if (!data) return [];
  const allPromises = data.flatMap((item) => [
    getDevState(new PublicKey(item.mint), new PublicKey(item.creator)),
    getMintDetails(item.mint),
  ]);
  const results = await Promise.all(allPromises);

  return data.map((item, index) => {
    const i = index * 2;
    const devState = results[i];
    const mintDetails = results[i + 1];
    const top10 = mintDetails?.top10HP;
    const holdersCount = mintDetails?.holdersCount;
    const cSupply = Number(mintDetails?.mintInfo.supply) / 10 ** TOKEN_DECIMALS;
    const price = item.usd_market_cap / TOTAL_SUPPLY;

    return {
      mint: item.mint,
      name: item.name,
      symbol: item.symbol,
      image_url: item.image_uri,
      twitter: item.twitter,
      telegram: item.telegram,
      creator: item.creator,
      created_timestamp: item.created_timestamp,
      total_supply: TOTAL_SUPPLY,
      usd_market_cap: item.usd_market_cap,
      fdv: price * cSupply,
      dev_state: devState,
      top10_percent: top10,
      circul_supply: cSupply,
      price: price,
      mint_auth: mintDetails?.mintInfo?.mintAuthority === null ? true : false,
      freeze_auth:
        mintDetails?.mintInfo?.freezeAuthority === null ? true : false,
      holdersCount,
    };
  });
};


*/
