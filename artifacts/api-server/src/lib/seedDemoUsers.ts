import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable, employeesTable } from "@workspace/db";
import { logger } from "./logger";

type DemoUser = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: "admin" | "employee";
};

const DEMO_USERS: DemoUser[] = [
  {
    email: "admin@secureops.com",
    password: "Admin123!",
    firstName: "Admin",
    lastName: "User",
    role: "admin",
  },
  {
    email: "john.smith@secureops.com",
    password: "Employee123!",
    firstName: "John",
    lastName: "Smith",
    role: "employee",
  },
];

/**
 * Idempotently provision the two documented demo accounts so the
 * credentials in `replit.md` always work. Behaviour:
 *  - If the user does not exist, create them (and an employees row when
 *    role=employee) with the documented password.
 *  - If the user exists but their stored password no longer matches the
 *    documented one, reset it to the documented value. This keeps the
 *    README in sync with reality even if a previous run rotated the pw.
 *  - Other fields on existing users are left alone.
 *
 * Disable with SEED_DEMO_USERS=false (e.g. in production).
 */
export async function seedDemoUsers(): Promise<void> {
  if (process.env["SEED_DEMO_USERS"] === "false") {
    logger.info("Demo user seeding disabled via SEED_DEMO_USERS=false");
    return;
  }

  for (const u of DEMO_USERS) {
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, u.email))
      .limit(1);

    if (!existing) {
      const passwordHash = await bcrypt.hash(u.password, 10);
      const [created] = await db
        .insert(usersTable)
        .values({
          email: u.email,
          passwordHash,
          firstName: u.firstName,
          lastName: u.lastName,
          role: u.role,
          status: "active",
          mustChangePassword: false,
          mustCompleteProfile: false,
        })
        .returning();
      if (created && u.role === "employee") {
        await db.insert(employeesTable).values({ userId: created.id });
      }
      logger.info({ email: u.email, role: u.role }, "Seeded demo user");
      continue;
    }

    const passwordOk = await bcrypt.compare(u.password, existing.passwordHash);
    if (!passwordOk) {
      const passwordHash = await bcrypt.hash(u.password, 10);
      await db
        .update(usersTable)
        .set({ passwordHash, mustChangePassword: false })
        .where(eq(usersTable.id, existing.id));
      logger.info({ email: u.email }, "Reset demo user password to documented value");
    }

    if (u.role === "employee") {
      const [emp] = await db
        .select()
        .from(employeesTable)
        .where(eq(employeesTable.userId, existing.id))
        .limit(1);
      if (!emp) {
        await db.insert(employeesTable).values({ userId: existing.id });
        logger.info({ email: u.email }, "Created missing employees row for demo user");
      }
    }
  }
}
