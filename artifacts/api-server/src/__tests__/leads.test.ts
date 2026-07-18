import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { db, salesLeadsTable } from "@workspace/db";
import app from "../app";

// Tagged so cleanup is precise and won't trample real seed data. Every lead
// we create carries this tag in its company_name so the afterAll sweep can
// remove exactly our rows.
const TAG = `leads-test-${randomUUID().slice(0, 8)}`;

// The public POST /leads endpoint is rate-limited per-IP (5/hr) AND per-email
// (5/window). The suite runs from a single source IP (127.0.0.1) which would
// trip the per-IP cap after a handful of submissions. The app sets
// `trust proxy 1`, so we can hand each request a distinct X-Forwarded-For to
// isolate its rate-limit bucket and keep the functional tests independent of
// one another (and of the dedicated rate-limit smoke test below).
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function submit(body: Record<string, unknown>, ip: string = nextIp()) {
  return request(app).post("/api/leads").set("X-Forwarded-For", ip).send(body);
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    companyName: TAG,
    contactName: "Pat Prospect",
    email: `${TAG}-${randomUUID().slice(0, 8)}@example.test`,
    ...overrides,
  };
}

afterAll(async () => {
  await db.execute(sql`DELETE FROM sales_leads WHERE company_name = ${TAG}`);
});

describe("POST /leads — public lead capture", () => {
  it("accepts a well-formed payload, persists the row, and returns 201", async () => {
    const body = validBody({ contactName: "Dana Director" });
    const res = await submit(body);

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.companyName).toBe(TAG);
    expect(res.body.contactName).toBe("Dana Director");
    expect(res.body.email).toBe(body.email);
    expect(res.body.status).toBe("new");
    expect(res.body.createdAt).toBeTruthy();

    // ---- DB invariant: the lead was actually persisted ----
    const [row] = await db
      .select()
      .from(salesLeadsTable)
      .where(eq(salesLeadsTable.id, res.body.id));
    expect(row).toBeTruthy();
    expect(row.companyName).toBe(TAG);
    expect(row.email).toBe(body.email);
    expect(row.status).toBe("new");
  });

  it("defaults source to 'marketing_site' when omitted", async () => {
    const res = await submit(validBody());
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("marketing_site");

    const [row] = await db
      .select()
      .from(salesLeadsTable)
      .where(eq(salesLeadsTable.id, res.body.id));
    expect(row.source).toBe("marketing_site");
  });

  it("honors an explicitly provided source", async () => {
    const res = await submit(validBody({ source: "pricing_enterprise" }));
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("pricing_enterprise");
  });

  it("normalizes email to lowercase + trims it", async () => {
    const local = `${TAG}-${randomUUID().slice(0, 8)}`;
    const res = await submit(validBody({ email: `  ${local}@EXAMPLE.TEST  ` }));
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(`${local}@example.test`);
  });

  it("persists optional fields (phone/tier/officerCount/message)", async () => {
    const message = "We run 40+ officers across three sites and want a demo.";
    const res = await submit(
      validBody({
        phone: "(214) 555-0142",
        tier: "professional",
        officerCount: 42,
        message,
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe("(214) 555-0142");
    expect(res.body.tier).toBe("professional");
    expect(res.body.officerCount).toBe(42);
    expect(res.body.message).toBe(message);

    const [row] = await db
      .select()
      .from(salesLeadsTable)
      .where(eq(salesLeadsTable.id, res.body.id));
    expect(row.phone).toBe("(214) 555-0142");
    expect(row.tier).toBe("professional");
    expect(row.officerCount).toBe(42);
    expect(row.message).toBe(message);
  });

  it("coerces a numeric-string officerCount to an integer", async () => {
    const res = await submit(validBody({ officerCount: "150" }));
    expect(res.status).toBe(201);
    expect(res.body.officerCount).toBe(150);
  });

  it("leaves omitted optional fields null", async () => {
    const res = await submit(validBody());
    expect(res.status).toBe(201);
    expect(res.body.phone).toBeNull();
    expect(res.body.tier).toBeNull();
    expect(res.body.officerCount).toBeNull();
    expect(res.body.message).toBeNull();
  });

  describe("validation — 400 on missing/invalid required fields", () => {
    it("rejects a missing companyName", async () => {
      const { companyName, ...rest } = validBody();
      void companyName;
      const res = await submit(rest);
      expect(res.status).toBe(400);
    });

    it("rejects a missing contactName", async () => {
      const { contactName, ...rest } = validBody();
      void contactName;
      const res = await submit(rest);
      expect(res.status).toBe(400);
    });

    it("rejects a missing email", async () => {
      const { email, ...rest } = validBody();
      void email;
      const res = await submit(rest);
      expect(res.status).toBe(400);
    });

    it("rejects an empty (whitespace-only) companyName", async () => {
      const res = await submit(validBody({ companyName: "   " }));
      expect(res.status).toBe(400);
    });

    it("rejects a malformed email", async () => {
      const res = await submit(validBody({ email: "not-an-email" }));
      expect(res.status).toBe(400);
    });

    it("does not persist a row for an invalid payload", async () => {
      const before = await db
        .select({ id: salesLeadsTable.id })
        .from(salesLeadsTable)
        .where(eq(salesLeadsTable.companyName, TAG));
      const res = await submit(validBody({ email: "bad" }));
      expect(res.status).toBe(400);
      const after = await db
        .select({ id: salesLeadsTable.id })
        .from(salesLeadsTable)
        .where(eq(salesLeadsTable.companyName, TAG));
      expect(after.length).toBe(before.length);
    });
  });

  describe("rate limiting", () => {
    it("returns 429 once the per-IP cap is exceeded", async () => {
      // Drive the limiter from one dedicated IP so we don't disturb the
      // isolated buckets used by the functional tests above. The default cap
      // is 5/hr/IP; the 6th submission from this IP must be blocked. We reuse
      // a single email too, so the per-email cap reinforces the same outcome.
      const ip = "198.51.100.7";
      const email = `${TAG}-ratelimit@example.test`;
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await submit(validBody({ email }), ip);
        statuses.push(res.status);
      }
      // Some prefix of requests succeed (201) and at least the final one is
      // rejected with 429 — proving the limiter is wired onto the route.
      expect(statuses).toContain(429);
      expect(statuses[statuses.length - 1]).toBe(429);
      expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(5);
    });
  });
});
