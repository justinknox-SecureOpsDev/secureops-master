import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  licensesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { normalizeEmployeeDraft } from "../lib/pdfEmployeeExtract";

const TAG = `pdfimport-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

function email(suffix: string): string {
  return `${TAG}-${suffix}@example.test`;
}

let adminId = "";
let adminToken = "";
const createdUserIds = new Set<string>();

async function makeUser(
  role: "admin" | "employee" | "client",
  suffix: string,
  status: "active" | "pending" | "inactive" = "active",
): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: email(suffix),
      passwordHash,
      firstName: "Test",
      lastName: TAG,
      role,
      status,
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  createdUserIds.add(row.id);
  return row.id;
}

function commit(body: Record<string, unknown>) {
  return request(app)
    .post("/api/admin/import/employees/commit-pdf")
    .set("Authorization", `Bearer ${adminToken}`)
    .send(body);
}

beforeAll(async () => {
  adminId = await makeUser("admin", "admin");
  adminToken = signToken({ userId: adminId, email: email("admin"), role: "admin" });
});

afterAll(async () => {
  const ids = [...createdUserIds];
  if (ids.length) {
    await db.delete(licensesTable).where(inArray(licensesTable.employeeId, ids));
    await db.delete(employeesTable).where(inArray(employeesTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
  // Sweep any employees created by the "create" tests (their userIds aren't
  // pre-known); match on the tagged email.
  await db.execute(sql`DELETE FROM licenses WHERE employee_id IN (SELECT id FROM users WHERE email LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${TAG}-%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${TAG}-%`}`);
});

describe("normalizeEmployeeDraft", () => {
  it("trims text, lowercases a valid email, and keeps a valid ISO date + level", () => {
    const { draft, warnings } = normalizeEmployeeDraft({
      firstName: "  Dana  ",
      lastName: "Director",
      email: "  Dana.Director@Example.COM ",
      dateOfBirth: "1990-04-01",
      siaLicenseLevel: 3,
      yearsExperience: "7",
    });
    expect(draft.firstName).toBe("Dana");
    expect(draft.email).toBe("dana.director@example.com");
    expect(draft.dateOfBirth).toBe("1990-04-01");
    expect(draft.siaLicenseLevel).toBe(3);
    expect(draft.yearsExperience).toBe(7);
    expect(warnings).toHaveLength(0);
  });

  it("drops an invalid email/date/level and reports a warning for each", () => {
    const { draft, warnings } = normalizeEmployeeDraft({
      email: "not-an-email",
      dateOfBirth: "not-a-date",
      siaLicenseLevel: 9,
    });
    expect(draft.email).toBeUndefined();
    expect(draft.dateOfBirth).toBeUndefined();
    expect(draft.siaLicenseLevel).toBeUndefined();
    expect(warnings.length).toBe(3);
  });

  it("rejects an impossible calendar date that Date would silently roll over", () => {
    const { draft, warnings } = normalizeEmployeeDraft({ dateOfBirth: "2024-02-31" });
    expect(draft.dateOfBirth).toBeUndefined();
    expect(warnings.length).toBe(1);
  });

  it('treats "" and "null" strings as absent', () => {
    const { draft } = normalizeEmployeeDraft({ firstName: "", lastName: "null", phone: "   " });
    expect(draft.firstName).toBeUndefined();
    expect(draft.lastName).toBeUndefined();
    expect(draft.phone).toBeUndefined();
  });
});

describe("POST /admin/import/employees/commit-pdf — create", () => {
  it("creates a new pending employee + license and normalizes the phone to E.164", async () => {
    const res = await commit({
      mode: "create",
      objectPath: "/objects/uploads/cv-1.pdf",
      fields: {
        firstName: "New",
        lastName: "Hire",
        email: email("newhire"),
        phone: "(214) 555-1234",
        siaLicenseNumber: "TX-12345",
        siaLicenseLevel: "3",
        siaLicenseExpiry: "2030-01-01",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const userId = res.body.userId as string;
    createdUserIds.add(userId);

    const [u] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(u.role).toBe("employee");
    expect(u.status).toBe("pending");
    expect(u.mustCompleteProfile).toBe(true);
    expect(u.phoneNumber).toBe("+12145551234");

    const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.userId, userId));
    expect(emp.phone).toBe("+12145551234");
    expect(emp.cvKey).toBe("/objects/uploads/cv-1.pdf");
    expect(emp.siaLicenseNumber).toBe("TX-12345");
    expect(emp.siaLicenseLevel).toBe(3);

    const lic = await db.select().from(licensesTable).where(eq(licensesTable.employeeId, userId));
    expect(lic).toHaveLength(1);
    expect(lic[0].type).toBe("Texas Security License");
    expect(lic[0].licenseNumber).toBe("TX-12345");
    expect(lic[0].level).toBe(3);
  });

  it("rejects a create whose email already exists with 409", async () => {
    await makeUser("employee", "dupe");
    const res = await commit({
      mode: "create",
      fields: { firstName: "Dup", lastName: "Licate", email: email("dupe") },
    });
    expect(res.status).toBe(409);
  });

  it("rejects a create missing the required name with 400", async () => {
    const res = await commit({
      mode: "create",
      fields: { firstName: "OnlyFirst", email: email("noname") },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable phone with 400 (and creates nothing)", async () => {
    const res = await commit({
      mode: "create",
      fields: { firstName: "Bad", lastName: "Phone", email: email("badphone"), phone: "12" },
    });
    expect(res.status).toBe(400);
    const rows = await db.select().from(usersTable).where(eq(sql`lower(${usersTable.email})`, email("badphone")));
    expect(rows).toHaveLength(0);
  });

  it("rejects an out-of-range license level with 400 (normalizer re-validation)", async () => {
    const res = await commit({
      mode: "create",
      fields: { firstName: "Bad", lastName: "Level", email: email("badlevel"), siaLicenseLevel: "9" },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/import/employees/commit-pdf — update", () => {
  it("updates an existing employee, mirrors the phone, and upserts the license", async () => {
    const userId = await makeUser("employee", "upd");
    await db.insert(employeesTable).values({ userId, directDepositConsent: false });

    const res = await commit({
      mode: "update",
      userId,
      fields: {
        firstName: "Updated",
        lastName: "Name",
        phone: "214-555-9999",
        siaLicenseNumber: "TX-99999",
        siaLicenseExpiry: "2031-06-30",
        siaLicenseLevel: "2",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);

    const [u] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(u.firstName).toBe("Updated");
    expect(u.phoneNumber).toBe("+12145559999");

    const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.userId, userId));
    expect(emp.phone).toBe("+12145559999");
    expect(emp.siaLicenseNumber).toBe("TX-99999");

    const lic = await db.select().from(licensesTable).where(eq(licensesTable.employeeId, userId));
    expect(lic).toHaveLength(1);
    expect(lic[0].licenseNumber).toBe("TX-99999");
    expect(lic[0].level).toBe(2);
  });

  it("preserves an existing license level when the import omits one", async () => {
    const userId = await makeUser("employee", "keeplevel");
    await db.insert(employeesTable).values({ userId, directDepositConsent: false });
    await db.insert(licensesTable).values({
      employeeId: userId,
      type: "Texas Security License",
      level: 3,
      licenseNumber: "TX-KEEP",
      expiryDate: "2030-01-01",
    });

    const res = await commit({
      mode: "update",
      userId,
      fields: {
        siaLicenseNumber: "TX-KEEP",
        siaLicenseExpiry: "2032-12-31",
        // siaLicenseLevel intentionally omitted
      },
    });
    expect(res.status).toBe(200);

    const lic = await db.select().from(licensesTable).where(eq(licensesTable.employeeId, userId));
    expect(lic).toHaveLength(1);
    expect(lic[0].level).toBe(3); // not cleared to null
    expect(lic[0].expiryDate).toBe("2032-12-31"); // provided field still applied
  });

  it("refuses to update a non-employee account with 400", async () => {
    const clientId = await makeUser("client", "clientacct");
    const res = await commit({ mode: "update", userId: clientId, fields: { firstName: "Nope" } });
    expect(res.status).toBe(400);
  });

  it("rejects an update whose form email doesn't match the target with 409", async () => {
    const userId = await makeUser("employee", "mismatch");
    const res = await commit({
      mode: "update",
      userId,
      fields: { firstName: "X", email: email("someoneelse") },
    });
    expect(res.status).toBe(409);
  });

  it("404s when the target user doesn't exist", async () => {
    const res = await commit({ mode: "update", userId: randomUUID(), fields: { firstName: "Ghost" } });
    expect(res.status).toBe(404);
  });
});

describe("commit-pdf authz", () => {
  it("rejects a non-admin caller", async () => {
    const empId = await makeUser("employee", "authz");
    const token = signToken({ userId: empId, email: email("authz"), role: "employee" });
    const res = await request(app)
      .post("/api/admin/import/employees/commit-pdf")
      .set("Authorization", `Bearer ${token}`)
      .send({ mode: "create", fields: { firstName: "A", lastName: "B", email: email("authz2") } });
    expect(res.status).toBe(403);
  });
});
