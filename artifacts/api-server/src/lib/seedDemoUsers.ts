import bcrypt from "bcryptjs";
import { eq, and, ne, sql } from "drizzle-orm";
import { db, usersTable, employeesTable } from "@workspace/db";
import { logger } from "./logger";
import { brand } from "./brandConfig";

type DemoUser = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: "admin" | "employee";
};

const DEMO_USERS: DemoUser[] = [
  {
    email: brand.demoAdminEmail,
    password: brand.demoAdminPassword,
    firstName: "Admin",
    lastName: "User",
    role: "admin",
  },
  {
    email: brand.demoEmployeeEmail,
    password: brand.demoEmployeePassword,
    firstName: "John",
    lastName: "Smith",
    role: "employee",
  },
];

/**
 * Clears the `mustChangePassword` flag for every active admin account.
 *
 * Admin accounts should never be blocked by a forced-change screen —
 * they use the password-reset flow if they need to update credentials.
 * The bulk-invite system only targets non-admin users, but flag drift
 * can still occur across dev/production databases. This runs
 * unconditionally on every boot so both environments stay consistent.
 */
export async function ensureAdminAccountHealth(): Promise<void> {
  const fixed = await db
    .update(usersTable)
    .set({ mustChangePassword: false })
    .where(
      and(
        eq(usersTable.role, "admin"),
        eq(usersTable.status, "active"),
        ne(usersTable.mustChangePassword, false),
      ),
    )
    .returning({ email: usersTable.email });

  if (fixed.length > 0) {
    logger.info(
      { emails: fixed.map((r) => r.email) },
      "Cleared stale mustChangePassword flag on active admin accounts",
    );
  }
}

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
      if (created) {
        // Every user (admin OR employee) gets an employees row so the
        // Personnel / Employees / Users views stay consistent — admins
        // work shifts too, so they need the same fields.
        await db.insert(employeesTable).values({ userId: created.id });
      }
      logger.info({ email: u.email, role: u.role }, "Seeded demo user");
      continue;
    }

    const passwordOk = await bcrypt.compare(u.password, existing.passwordHash);
    const needsUpdate = !passwordOk || existing.status !== "active" || existing.mustChangePassword;
    if (needsUpdate) {
      const passwordHash = passwordOk ? existing.passwordHash : await bcrypt.hash(u.password, 10);
      await db
        .update(usersTable)
        .set({ passwordHash, mustChangePassword: false, status: "active" })
        .where(eq(usersTable.id, existing.id));
      logger.info({ email: u.email }, "Reset demo user to documented credentials and active status");
    }

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

/**
 * Backfill: every user in the system must have an `employees` row.
 *
 * Historically only employee-role users got a row, so admins (who also
 * cover shifts) were absent from the Employees grid and the
 * `/employees` JOIN. This keeps the three personnel surfaces
 * (Users / Personnel / Employees) in lockstep without changing roles.
 *
 * Safe to re-run on every boot: a single LEFT JOIN finds users with no
 * `employees` row and inserts the bare-minimum link record (`userId`
 * only). All other employee fields stay null until the user (or admin)
 * fills them in.
 */
export async function ensureEmployeesRowsForAllUsers(): Promise<void> {
  const missing = await db.execute(sql`
    SELECT u.id, u.email
    FROM users u
    LEFT JOIN employees e ON e.user_id = u.id
    WHERE e.id IS NULL
  `);
  const rows = missing.rows as { id: string; email: string }[];
  if (rows.length === 0) return;
  await db.insert(employeesTable).values(rows.map((r) => ({ userId: r.id })));
  logger.info(
    { count: rows.length, emails: rows.map((r) => r.email) },
    "Backfilled missing employees rows so Personnel/Employees/Users views stay consistent",
  );
}
