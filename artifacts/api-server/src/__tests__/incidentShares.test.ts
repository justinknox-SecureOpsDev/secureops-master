import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import {
  db,
  usersTable,
  incidentsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `incshare-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  employeeId: string;
  adminToken: string;
  employeeToken: string;
  employeeEmail: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "employee", firstName: string): Promise<{ id: string; email: string }> {
  const email = `${TAG}-${role}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      firstName,
      lastName: TAG,
      role,
      status: "active",
      phoneNumber: "+15555550100",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return { id: row.id, email };
}

beforeAll(async () => {
  const admin = await makeUser("admin", "Alex");
  const emp = await makeUser("employee", "Felicity");
  ctx.adminId = admin.id;
  ctx.employeeId = emp.id;
  ctx.employeeEmail = emp.email;
  ctx.adminToken = signToken({ userId: admin.id, email: admin.email, role: "admin" });
  ctx.employeeToken = signToken({ userId: emp.id, email: emp.email, role: "employee" });
});

afterAll(async () => {
  const ids = [ctx.adminId, ctx.employeeId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    // incident_share_links cascades on incidents delete, incidents
    // cascade on user delete — but be explicit for ordering safety.
    await db.execute(sql`DELETE FROM incident_share_links WHERE incident_id IN (SELECT id FROM incidents WHERE employee_id = ANY(${arr}))`);
    await db.execute(sql`DELETE FROM incidents WHERE employee_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function createIncident(): Promise<string> {
  const res = await request(app)
    .post("/api/incidents")
    .set(authed(ctx.employeeToken))
    .send({
      title: `${TAG}-incident`,
      description: "Suspicious activity at perimeter; logged for record.",
      severity: "high",
      occurredAt: new Date().toISOString(),
      locationDescription: "North gate",
    });
  expect(res.status).toBe(201);
  expect(res.body.id).toBeTruthy();
  expect(res.body.status).toBe("open");
  return res.body.id;
}

describe("incident creation + admin share-link lifecycle", () => {
  it("creates an incident, mints a share link, lists it, public reads it sanitized, then revoke locks it out", async () => {
    const incidentId = await createIncident();

    // Stamp adminNotes onto the incident so we can confirm the public
    // surface NEVER returns this field (it's the privileged-only
    // disposition channel).
    await db
      .update(incidentsTable)
      .set({ adminNotes: "INTERNAL: escalate to client legal Monday" })
      .where(sql`${incidentsTable.id} = ${incidentId}`);

    // ----- mint a share link -----
    const mint = await request(app)
      .post(`/api/admin/incidents/${incidentId}/share`)
      .set(authed(ctx.adminToken))
      .send({ expiresInDays: 7, recipientLabel: "Acme Mall — Janet" });
    expect(mint.status).toBe(201);
    expect(mint.body.token).toBeTruthy();
    expect(mint.body.url).toMatch(/\/admin-portal\/share\/incident\//);
    expect(mint.body.recipientLabel).toBe("Acme Mall — Janet");
    expect(new Date(mint.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const shareId: string = mint.body.id;
    const token: string = mint.body.token;

    // ----- admin list shows it -----
    const list = await request(app)
      .get(`/api/admin/incident-shares?incidentId=${incidentId}`)
      .set(authed(ctx.adminToken));
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const listed = list.body.find((r: { id: string }) => r.id === shareId);
    expect(listed).toBeTruthy();
    expect(listed.url).toMatch(/\/admin-portal\/share\/incident\//);
    expect(listed.viewCount).toBe(0);

    // ----- public reads sanitized, no admin notes, no PII leakage -----
    const pub = await request(app).get(`/api/public/incident-shares/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.id).toBe(incidentId);
    expect(pub.body.title).toBe(`${TAG}-incident`);
    // Redaction guarantees: adminNotes is the single most sensitive
    // internal field, officer email/phone never go out the public
    // surface, and the officer's full identity is reduced to "F. Last"
    // so the client can attribute a responder without leaking their
    // first name.
    expect(pub.body.adminNotes).toBeUndefined();
    expect(pub.body.employeeId).toBeUndefined();
    expect(pub.body.employeeEmail).toBeUndefined();
    expect(pub.body.employeePhone).toBeUndefined();
    expect(pub.body.employeeName).toBeUndefined();
    expect(pub.body.responderName).toBe(`F. ${TAG}`);
    // Sanity: stringifying the body must not contain the admin note
    // or the officer's full first name or email.
    const blob = JSON.stringify(pub.body);
    expect(blob).not.toContain("INTERNAL: escalate");
    expect(blob).not.toContain("Felicity");
    expect(blob).not.toContain(ctx.employeeEmail);
    // View counter advanced.
    expect(pub.body.share.viewCount).toBe(1);

    // ----- revoke -----
    const rev = await request(app)
      .post(`/api/admin/incident-shares/${shareId}/revoke`)
      .set(authed(ctx.adminToken))
      .send({});
    expect(rev.status).toBe(200);
    expect(rev.body.revokedAt).toBeTruthy();

    // ----- public access now gone (410) -----
    const pubAfter = await request(app).get(`/api/public/incident-shares/${token}`);
    expect(pubAfter.status).toBe(410);
    expect(pubAfter.body.error).toMatch(/revoked/i);

    // ----- second revoke is a clean 409, not a 500 -----
    const revAgain = await request(app)
      .post(`/api/admin/incident-shares/${shareId}/revoke`)
      .set(authed(ctx.adminToken))
      .send({});
    expect(revAgain.status).toBe(409);
    expect(revAgain.body.message).toMatch(/already revoked/i);
  });

  it("returns 404 for an unknown public token", async () => {
    const res = await request(app).get(`/api/public/incident-shares/${randomUUID().replace(/-/g, "")}`);
    expect(res.status).toBe(404);
  });

  it("blocks non-admin employees from minting share links", async () => {
    const incidentId = await createIncident();
    const res = await request(app)
      .post(`/api/admin/incidents/${incidentId}/share`)
      .set(authed(ctx.employeeToken))
      .send({});
    expect(res.status).toBe(403);
  });
});
