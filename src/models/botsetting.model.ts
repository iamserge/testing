import mongoose, { Schema } from 'mongoose';

const WorkingHoursSchema = new Schema({
  start: { type: String, required: true },
  end: { type: String, required: true },
  enabled: { type: Boolean, required: true }
});

const BuySettingsSchema = new Schema({
  duplicates: {
    enabled: { type: Boolean, required: true }
  },
  marketCap: {
    min: { type: Number, required: true },
    max: { type: Number, required: true },
    enabled: { type: Boolean, required: true }
  },
  age: {
    start: { type: Number, required: true },
    end: { type: Number, required: true },
    enabled: { type: Boolean, required: true }
  },
  maxDevHoldingAmount: {
    value: { type: Number, required: true },
    enabled: { type: Boolean, required: true }
  },
  maxDevBuyAmount: {
    value: { type: Number, required: true },
    enabled: { type: Boolean, required: true }
  },
  holders: {
    value: { type: Number, required: true },
    enabled: { type: Boolean, required: true }
  },
  lastMinuteTxns: {
    value: { type: Number, required: true },
    enabled: { type: Boolean, required: true }
  },
  lastHourVolume: {
    value: { type: Number, required: true },
    enabled: { type: Boolean, required: true }
  },
  xScore: {
    value: { type: Number, required: true },
    enabled: { type: Boolean, required: true }
  },
  maxGasPrice: { type: Number, required: true },
  slippage: { type: Number, required: true },
  jitoTipAmount: { type: Number, required: true },
  investmentPerToken: { type: Number, required: true }
});

const SaleRuleSchema = new Schema({
  percent: { type: Number, required: true },
  revenue: { type: Number, required: true }
});

const SellSettingsSchema = new Schema({
  saleRules: [SaleRuleSchema],
  lossExitPercent: { type: Number, required: true },
  mcChange: {
    percentValue: { type: Number, required: true},
    duration: { type: Number, required: true}
  }
});

const BotSettingsSchema = new Schema({
  mainConfig: {
    isRunning: { type: Boolean, required: true },
    workingHours: WorkingHoursSchema,
    buyIntervalTime: { type: Number, required: true },
    sellIntervalTime: { type: Number, required: true }
  },
  buyConfig: BuySettingsSchema,
  sellConfig: SellSettingsSchema,
  updatedAt: { type: Date, default: Date.now }
});

export const BotSettingsModel = mongoose.model('BotSettings', BotSettingsSchema);
