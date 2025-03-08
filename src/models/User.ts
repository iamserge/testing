import mongoose, { Schema } from "mongoose";

export interface IUser {
  email: string;
  role: string;
}

const UserSchema: Schema = new Schema({
  email: { type: String, required: true },
  role: { type: String, required: true },
});

export const DBUser = mongoose.model("User", UserSchema);
