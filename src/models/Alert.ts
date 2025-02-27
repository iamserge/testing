import mongoose, { Schema } from "mongoose";
import { IAlertMsg } from "../utils/types";

const AlertMsgSchema: Schema = new Schema({
  imageUrl: { type: String, required: true },
  title: { type: String, required: true },
  content: { type: String, required: true },
  link: { type: String, required: true },
  time: { type: Number, required: true },
  isRead: { type: Boolean, required: true },
});

export const AlertService = mongoose.model<IAlertMsg>(
  "AlertMsg",
  AlertMsgSchema
);
