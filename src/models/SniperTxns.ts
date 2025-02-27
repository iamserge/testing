import mongoose, { Schema, Document } from "mongoose";

export interface ITransaction extends Document {
  txHash: string;
  mint: string;
  txTime: number;
  tokenName: string;
  tokenSymbol: string;
  tokenImage: string;
  swap: "BUY" | "SELL";
  swapPrice_usd: number;
  swapAmount: number;
  swapSolAmount?: number;
  swapFee_usd: number;
  swapMC_usd: number;
  swapProfit_usd?: number;
  swapProfitPercent_usd?: number;
  buyMC_usd?: number;
  date: number;
}

const TransactionSchema = new Schema({
  txHash: { type: String, required: true, unique: true },
  mint: { type: String, required: true },
  txTime: { type: Number },
  tokenName: { type: String, required: true },
  tokenSymbol: { type: String, required: true },
  tokenImage: { type: String },
  swap: { type: String, enum: ["BUY", "SELL"], required: true },
  swapPrice_usd: { type: Number, required: true },
  swapAmount: { type: Number, required: true },
  swapSolAmount: { type: Number },
  swapFee_usd: { type: Number },
  swapMC_usd: { type: Number },
  swapProfit_usd: { type: Number },
  swapProfitPercent_usd: { type: Number },
  buyMC_usd: { type: Number },
  date: { type: Number, default: Date.now },
});

export const SniperTxns = mongoose.model<ITransaction>(
  "SniperTransaction",
  TransactionSchema
);
