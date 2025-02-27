import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import User from "../../models/User";
import logger from "../../logs/logger";
import { config, OPT_EXPIRE_TIME, USER_EMAILS, wallet } from "../../config";
import { generateRandomOTP, sendOTP2Email } from "../../utils/otp";

const router = Router();

const otpStore = new Map<string, { code: string; timestamp: number }>();

router.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      username,
      email,
      password: hashedPassword,
    });

    await user.save();
    logger.info(`New user registered: ${username}`);
    res.status(201).json({ message: "User registered successfully" });
  } catch (error: any) {
    logger.error(`Registration error: ${error.message}`);
    res.status(500).json({ message: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const storedOTP = otpStore.get(email);
    if (!storedOTP) {
      return res.status(400).json({ message: "No OTP found for this email" });
    }
    if (Date.now() - storedOTP.timestamp > OPT_EXPIRE_TIME) {
      otpStore.delete(email);
      return res.status(400).json({ message: "OTP has expired" });
    }

    // Verify OTP
    if (storedOTP.code !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }
    // Clear OTP after successful verification
    otpStore.delete(email);

    // Generate JWT token with additional claimss
    const token = jwt.sign(
      {
        email,
        walletAddress: wallet.publicKey.toBase58(),
        timestamp: Date.now(),
      },
      config.jwtSecret,
      { expiresIn: "24h" }
    );

    const walletAddress = wallet.publicKey.toBase58();

    logger.info(`User logged in successfully: ${email}`);
    res.status(200).json({
      message: "Login successful",
      token,
      walletAddress,
      email,
    });
  } catch (error: any) {
    logger.error(`Login error: ${error.message}`);
    res.status(500).json({
      message: "Login failed",
      error: error.message,
    });
  }
});

router.post("/sendcode", async (req, res) => {
  try {
    const { email } = req.body;
    const userEmails = USER_EMAILS;
    if (!userEmails.includes(email)) {
      logger.warn(`Login attempt failed for email: ${email}`);
      return res.status(401).json({ message: "Not registered user." });
    }
    // send code to gmail
    const code = generateRandomOTP();
    logger.info(`Generated OTP: ${code} for email: ${email}`);
    await sendOTP2Email({ email, code });
    otpStore.set(email, { code, timestamp: Date.now() });

    return res.status(200).json({
      message: "Code sent successfully",
      timestamp: Date.now(),
    });
  } catch (error: any) {
    logger.error(`Login error: ${error.message}`);
    res.status(500).json({
      message: "Login failed",
      error: error.message,
    });
  }
});

// Add this route after your login route
router.post("/logout", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, config.jwtSecret) as { email: string };
      logger.info(`User logged out successfully: ${decoded.email}`);
    }

    res.status(200).json({
      message: "Logged out successfully",
      timestamp: Date.now(),
    });
  } catch (error: any) {
    logger.error(`Logout error: ${error.message}`);
    res.status(500).json({
      message: "Logout failed",
      error: error.message,
    });
  }
});

export default router;
