import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  db,
  clientsTable,
  sitesTable,
  subcontractorsTable,
  subcontractorQrTokensTable,
  subcontractorTimeEntriesTable,
} from "@workspace/db";
import app from "../app";

const TAG = `subqr-test-${randomUUID().slice(0, 8)}`;

type Ctx = {
  clientId: string;
  siteId: string;
  token: string;
  vendorIds: string[];
};
const ctx = { vendorIds: [] } as Ctx;

beforeAll(async () => {
  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 QR Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  ctx.token = `${TAG}-${randomUUID()}`;
  await db.insert(subcontractorQrTokensTable).values({ siteId: ctx.siteId, token: ctx.token });

  // Two master vendors (canonical casing) + a historical free-text company that
  // duplicates one vendor with different casing (must collapse, vendor casing wins).
  const vendors = await db
    .insert(subcontractorsTable)
    .values([
      { companyName: `${TAG} Zenith Patrol` },
      { companyName: `${TAG} Acme Security` },
    ])
    .returning({ id: subcontractorsTable.id });
  ctx.vendorIds = vendors.map((v) => v.id);

  await db.insert(subcontractorTimeEntriesTable).values([
    // Same company as a vendor but lowercased — should dedupe to the vendor row.
    { siteId: ctx.siteId, name: "Jane Doe", company: `${TAG} acme security`.toLowerCase(), clockInAt: new Date() },
    // A company seen only in entries (never a master vendor) — must still appear.
    { siteId: ctx.siteId, name: "Bob Roe", company: `${TAG} Lone Star Guards`, clockInAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM subcontractor_time_entries WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM subcontractor_qr_tokens WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM subcontractors WHERE company_name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
});

describe("GET /subcontractor/clock/:token company list", () => {
  it("returns site context plus a deduped, sorted, vendor-cased company list", async () => {
    const res = await request(app).get(`/api/subcontractor/clock/${encodeURIComponent(ctx.token)}`);
    expect(res.status).toBe(200);
    expect(res.body.siteId).toBe(ctx.siteId);

    const ours = (res.body.companies as string[]).filter((c) => c.startsWith(TAG));

    // Case-insensitive dedupe keeps the master vendor's casing ("Acme Security",
    // not the lowercased time-entry value).
    expect(ours).toContain(`${TAG} Acme Security`);
    expect(ours).not.toContain(`${TAG} acme security`.toLowerCase());

    // A company that exists only in historical entries still surfaces.
    expect(ours).toContain(`${TAG} Lone Star Guards`);

    // No duplicate of the deduped vendor.
    const acmeCount = ours.filter((c) => c.toLowerCase() === `${TAG} acme security`.toLowerCase()).length;
    expect(acmeCount).toBe(1);

    // Alphabetically sorted.
    const sorted = [...ours].sort((a, b) => a.localeCompare(b));
    expect(ours).toEqual(sorted);
  });

  it("returns 410 for an unknown or revoked token", async () => {
    const res = await request(app).get(`/api/subcontractor/clock/${encodeURIComponent(TAG + "-nope")}`);
    expect(res.status).toBe(410);
  });
});
