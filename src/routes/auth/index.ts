import jwt from "jsonwebtoken";
import { Router } from "express";
import logger from "../../logs/logger";
import { generateRandomOTP, sendOTP2Email } from "../../utils/otp";
import { config, OPT_EXPIRE_TIME, wallet } from "../../config";
import { createUser, getAllUsers, getUserByEmail, isAdminUser, removeUserByEmail } from "../../service/users/user";

const router = Router();

const otpStore = new Map<string, { code: string; timestamp: number }>();

router.post("/login", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const userEmails = (await getAllUsers()).map((user) => user.email);
    if (!userEmails.includes(email)) {
      logger.warn(`Login attempt failed for email: ${email}`);
      return res.status(401).json({ message: "Not registered user." });
    }
    const storedOTP = otpStore.get(email);
    if (!storedOTP) {
      return res.status(400).json({ message: "No OTP found for this email" });
    }
    if (Date.now() - storedOTP.timestamp > OPT_EXPIRE_TIME) {
      otpStore.delete(email);
      return res.status(400).json({ message: "OTP has expired" });
    }
    if (storedOTP.code !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }
    otpStore.delete(email);
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
    const user = await getUserByEmail(email);

    logger.info(`User logged in successfully: ${email}`);
    res.status(200).json({
      message: "Login successful",
      token,
      walletAddress,
      email,
      role: user?.role,
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
    const userEmails = (await getAllUsers()).map((user) => user.email);
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

router.post("/register", async (req, res) => {
  try {
    const { email, role } = req.body;
    console.log("[ POST ] /register email: ", email, role);
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "`The request is not authorized" });
    }
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, config.jwtSecret) as { email: string };
    const request_user = decoded.email;
    const isAdmin = await isAdminUser(request_user);
    if(!isAdmin) {
      return res.status(401).json({ message: "Not authorized to register" });
    }
    const userEmails = (await getAllUsers()).map((user) => user.email);
    if (userEmails.includes(email)) {
      return res.status(400).json({ message: "Email already registered" });
    }
    console.log("8", email, role)
    const newUser = await createUser({ email, role });
    console.log("9")
    if(newUser) {
      logger.info(`User registered successfully: ${email}`);
      res.status(201).json({ message: "User registered successfully" });
    } else {
      console.log("10")
      res.status(500).json({ message: "User registration failed" });
    }
  } catch(error: any) {
    console.log(error)
    res.status(500).json({
      message: "Registration failed",
      error: error.message,
    });
  }
});

router.post("/delete", async (req, res) => {
  try {
    const { email } = req.body;
    console.log("[ POST ] /delete email: ", email);
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "The request is not authorized" });
    }
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, config.jwtSecret) as { email: string };
    const request_user = decoded.email;
    const isAdmin = await isAdminUser(request_user);
    if(!isAdmin) {
      return res.status(401).json({ message: "You are not authorized to delete" });
    }
    if(email === request_user) {
      return res.status(401).json({ message: "You can't delete yourself" });
    }
    const isRootRemove = await isAdminUser(email);
    if(isRootRemove) {
      return res.status(401).json({ message: "You can't delete root user" });
    }

    const userEmails = (await getAllUsers()).map((user) => user.email);
    if (!userEmails.includes(email)) {
      return res.status(400).json({ message: "Email not registered" });
    }
    const deletedUser = await removeUserByEmail(email);
    if(deletedUser) {
      res.status(200).json({ message: "User deleted successfully" });
    } else {
      res.status(500).json({ message: "User deletion failed" });
    }
  } catch (error:any) {
    res.status(500).json({
      message: "User deletion failed",
      error: error.message,
    });
  }
});

router.get("/get-users", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "Not authorized to get users" });
    }
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, config.jwtSecret) as { email: string };
    const request_user = decoded.email;
    const isAdmin = await isAdminUser(request_user);
    if(!isAdmin) {
      return res.status(401).json({ message: "Not authorized to get users" });
    }
    const users = await getAllUsers();
    if(users) {
      res.status(200).json({ users });
    } else {
      res.status(500).json({ message: "Users retrieval failed" });
    }
  } catch(error:any) {
    res.status(500).json({
      message: "Users retrieval failed",
      error: error.message,
    });
  }
});

export default router;
