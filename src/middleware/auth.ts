import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";

export interface CustomRequest extends Request {
  user?: any;
}

export const validateJWT = (
  req: CustomRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      // logger.warn("No JWT token provided");
      return res.status(401).json({ message: "Authentication required" });
    }

    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded;

    next();
  } catch (error: any) {
    // logger.error(`JWT validation failed: ${error.message}`);
    return res.status(401).json({ message: "Invalid token" });
  }
};
