import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { issueOperatorToken, verifyOperatorCredentials } from "../auth";
import { logger } from "../logger";

export const authRouter = Router();

// Single-operator auth surface — throttle credential guessing per source IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post("/auth/login", loginLimiter, (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  const { email, password } = parsed.data;
  if (!verifyOperatorCredentials(email, password)) {
    logger.warn({ email }, "[auth] failed operator login");
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const token = issueOperatorToken();
  res.json({ token });
});
