import nodemailer from "nodemailer";
import { SMTP_KEY, SMTP_USER } from "../config";

const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false,
  auth: {
    user: SMTP_USER, // Your Brevo email
    pass: SMTP_KEY, // Your generated SMTP key
  },
});

export const sendOTP2Email = async ({
  email,
  code,
}: {
  email: string;
  code: string;
}) => {
  try {
    // Email options
    const mailOptions = {
      from: `"Pumpfun" <noreply@loyaltyjam.com>`,
      to: email,
      subject: "🚀 Solana Pumpfun Sniper Bot 🚀",
      text: `Hello`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #14F195;">Welcome to Solana Pumpfun Sniper Bot! 🚀</h2>
          <p>Your verification code is:</p>
          <div style="background: #1E1E1E; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <h1 style="color: #14F195; text-align: center; letter-spacing: 5px; margin: 0;">${code}</h1>
          </div>
          <p>This code will expire in 5 minutes.</p>
          <p style="color: #666; font-size: 12px; margin-top: 20px;">
            If you didn't request this code, please ignore this email.
          </p>
          <hr style="border: 1px solid #eee; margin: 20px 0;">
          <p style="color: #666; font-size: 12px; text-align: center;">
            Solana Pumpfun Sniper Bot - Trade Smarter, Profit Faster
          </p>
        </div>
      `,
    };
    const info = await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error("Error occurred:", error);
  }
};

export const generateRandomOTP = () => {
  const numbers = "0123456789";
  const upperCase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lowerCase = "abcdefghijklmnopqrstuvwxyz";
  const specialChars = "#@$%&*";

  const allChars = numbers + upperCase + lowerCase + specialChars;
  let otp = "";

  // Ensure at least one of each type
  otp += numbers[Math.floor(Math.random() * numbers.length)];
  otp += upperCase[Math.floor(Math.random() * upperCase.length)];
  otp += lowerCase[Math.floor(Math.random() * lowerCase.length)];
  otp += specialChars[Math.floor(Math.random() * specialChars.length)];

  // Fill remaining length with random characters
  while (otp.length < 8) {
    otp += allChars[Math.floor(Math.random() * allChars.length)];
  }

  // Shuffle the OTP
  return otp
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
};
