import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, employeesTable } from "@workspace/db";
import { requireAuth, signToken } from "../middlewares/auth";

const router: IRouter = Router();

function userPayload(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    mustCompleteProfile: user.mustCompleteProfile,
    createdAt: user.createdAt,
  };
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "Bad Request", message: "Email and password required" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase()));
  if (!user) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid credentials" });
    return;
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid credentials" });
    return;
  }
  const token = signToken({ userId: user.id, email: user.email, role: user.role });
  res.json({ token, user: userPayload(user) });
});

router.post("/auth/logout", (_req, res): void => {
  res.json({ success: true });
});

router.post("/auth/push-token", requireAuth, async (req, res): Promise<void> => {
  const { token } = req.body as { token: string };
  if (!token) { res.status(400).json({ error: "Bad Request", message: "token required" }); return; }
  await db.update(usersTable).set({ expoPushToken: token }).where(eq(usersTable.id, req.user!.userId));
  res.json({ success: true });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId));
  if (!user) {
    res.status(404).json({ error: "Not Found", message: "User not found" });
    return;
  }
  res.json(userPayload(user));
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

router.post("/auth/change-password", requireAuth, async (req, res): Promise<void> => {
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const { currentPassword, newPassword } = parsed.data;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId));
  if (!user) {
    res.status(404).json({ error: "Not Found", message: "User not found" });
    return;
  }
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Unauthorized", message: "Current password is incorrect" });
    return;
  }
  if (currentPassword === newPassword) {
    res.status(400).json({ error: "Bad Request", message: "New password must be different from current password" });
    return;
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  const [updated] = await db.update(usersTable)
    .set({ passwordHash, mustChangePassword: false })
    .where(eq(usersTable.id, user.id))
    .returning();
  // Rotate session.
  const token = signToken({ userId: updated.id, email: updated.email, role: updated.role });
  res.json({ token, user: userPayload(updated) });
});

// Self-service profile edit. Strict allow-list of editable employee-row
// fields. Email, name, role, status, hourlyRate, license info, and any
// user-account field are intentionally NOT editable here — those must go
// through admin / HR.
const PatchMeEmployeeBody = z.object({
  phone: z.string().optional(),
  address: z.string().optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactRelationship: z.string().nullable().optional(),
  emergencyContactPhone: z.string().optional(),
  uniformShirt: z.string().nullable().optional(),
  uniformTrousers: z.string().nullable().optional(),
  uniformJacket: z.string().nullable().optional(),
  uniformBoots: z.string().nullable().optional(),
  bankAccountName: z.string().nullable().optional(),
  bankAccountNumber: z.string().nullable().optional(),
  bankBsb: z.string().nullable().optional(),
  skills: z.array(z.string()).optional(),
}).strict();

router.patch("/me/employee", requireAuth, async (req, res): Promise<void> => {
  const parsed = PatchMeEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No editable fields provided" });
    return;
  }
  const userId = req.user!.userId;
  const [existing] = await db.select().from(employeesTable).where(eq(employeesTable.userId, userId)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Not Found", message: "Employee profile not found" });
    return;
  }
  await db.update(employeesTable).set(updates).where(eq(employeesTable.userId, userId));
  // Clear must-complete-profile once they've saved their profile.
  await db.update(usersTable).set({ mustCompleteProfile: false }).where(eq(usersTable.id, userId));
  const [employee] = await db.select().from(employeesTable).where(eq(employeesTable.userId, userId)).limit(1);
  res.json(employee);
});

export default router;
