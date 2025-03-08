import { DBUser, IUser } from "../../models/User";

export const createUser = async (userData: IUser) => {
  const newUser = new DBUser(userData);
  return await newUser.save();
};

export const getUserByEmail = async (email: string) => {
  return await DBUser.findOne({ email });
};

export const removeUserByEmail = async (email: string) => {
  return await DBUser.deleteOne({ email });
};

export const getAllUsers = async () => {
  return await DBUser.find();
};

export const isAdminUser = async (email: string) => {
  const user = await getUserByEmail(email);
  if (!user) {
    return false;
  }
  if (user.role === "admin" || user.role === "root") {
    return true;
  }
};
