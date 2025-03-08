import mongoose, { Schema, Document } from 'mongoose';

export interface IToken extends Document {
  mint: string;
  tokenName: string;
  tokenSymbol: string;
  tokenImage: string;
  saveTime: number;
}

const TokenListSchema = new Schema({
  mint: {
    type: String,
    required: true,
    unique: true
  },
  tokenName: {
    type: String,
    required: true
  },
  tokenSymbol: {
    type: String,
    required: true
  },
  tokenImage: {
    type: String,
    default: ''
  },
  saveTime: {
    type: Number,
    default: Date.now
  }
});

export const DBTokenList = mongoose.model<IToken>('DBTokenList', TokenListSchema);
