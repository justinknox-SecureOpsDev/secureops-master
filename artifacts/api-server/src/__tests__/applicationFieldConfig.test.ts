import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  applicationsTable,
  applicationFieldConfigTable,
  type ApplicationFieldConfig,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import {
  APPLICATION_FIELD_REGISTRY,
  APPLICATION_FIELD_SECTIONS,
} from "../lib/applicationFields";

/**
 * Regression coverage for the admin form-builder field config, end-to-end.
 *
 * Guards the architect-flagged payload bug — when an admin hides or relaxes a
 * built-in application field, the public POST /applications submit must (a)
 * still succeed without that field and (b) NEVER persist a value the form no
 * longer collects. Also pins the locked-core-field invariant on
 * PATCH /admin/application-fields/:key and the section-scoped reorder contract.
 *
 * `application_field_config` is a single global table (no per-row tenancy), so
 * each test starts from a clean slate (afterEach wipes it) and the suite
 * snapshots + restores any pre-existing rows around the whole run. The
 * api-server vitest config runs files serially (singleFork), so this global
 * mutation can't race other suites.
 */

const TAG = `fieldcfg-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = { adminId: string; adminToken: string };
const ctx = {} as Ctx;

/** Rows present before the suite ran; restored verbatim in afterAll. */
let preexistingConfig: ApplicationFieldConfig[] = [];

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// A complete, valid submission. Built-in file paths use the anonymous-upload
// namespace so isApplicationObjectPath() accepts them. Callers can delete keys
// from the returned object to simulate a form that no longer collects them.
function buildApplicationBody(suffix: string): Record<string, unknown> {
  const futureExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return {
    firstName: "Jane",
    lastName: TAG,
    email: `${TAG}-${suffix}@example.test`,
    phone: "(214) 555-1234",
    address: "100 Test Way",
    city: "Dallas",
    state: "TX",
    zip: "75201",
    dateOfBirth: "1990-01-01",
    cityOfBirth: "Dallas",
    stateOfBirth: "TX",
    niNumber: "123-45-6789",
    i9: { citizenshipStatus: "citizen", usedPreparer: false, attestation: true, signatureName: `Jane ${TAG}` },
    ssnCardDoc: { name: "ssn.pdf", objectPath: `/objects/uploads/${randomUUID()}` },
    idDocType: "drivers_license",
    idDoc: { name: "id.pdf", objectPath: `/objects/uploads/${randomUUID()}` },
    siaLicenseNumber: `${TAG}-SIA-${suffix}`,
    siaLicenseLevel: 3,
    siaLicenseExpiry: futureExpiry,
    previousExperience: "2 years event security",
    yearsExperience: 2,
    references: [
      { name: "Ref One", relationship: "Manager", phone: "+12145550199", email: "ref1@example.test" },
    ],
    photo: { name: "photo.jpg", objectPath: `/objects/uploads/${randomUUID()}` },
    cv: { name: "cv.pdf", objectPath: `/objects/uploads/${randomUUID()}` },
    trainingCertificates: [{ name: "cert.pdf", objectPath: `/objects/uploads/${randomUUID()}` }],
    availability: [{ day: "mon", period: "morning" }],
  };
}

/** Insert/override a single built-in field's config (simulates an admin tweak). */
async function setFieldConfig(
  fieldKey: string,
  patch: Partial<{ hidden: boolean; requiredOverride: boolean | null; sortOrder: number }>,
): Promise<void> {
  await db
    .insert(applicationFieldConfigTable)
    .values({ fieldKey, ...patch })
    .onConflictDoUpdate({
      target: applicationFieldConfigTable.fieldKey,
      set: { ...patch, updatedAt: new Date() },
    });
}

async function fetchApplicationByEmail(email: string) {
  const [row] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.email, email.toLowerCase()));
  return row;
}

beforeAll(async () => {
  // Snapshot + clear so tests start from registry defaults.
  preexistingConfig = await db.select().from(applicationFieldConfigTable);
  await db.delete(applicationFieldConfigTable);

  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@example.test`,
      passwordHash,
      firstName: "Admin",
      lastName: TAG,
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.adminId = admin.id;
  ctx.adminToken = signToken({ userId: admin.id, email: `${TAG}-admin@example.test`, role: "admin" });
});

afterEach(async () => {
  // Reset to registry defaults between tests.
  await db.delete(applicationFieldConfigTable);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM applications WHERE last_name = ${TAG}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
  // Restore the config table exactly as we found it.
  await db.delete(applicationFieldConfigTable);
  if (preexistingConfig.length > 0) {
    await db.insert(applicationFieldConfigTable).values(preexistingConfig);
  }
});

describe("POST /applications — hidden built-in fields", () => {
  it("accepts a submission that omits hidden fields and nulls them server-side", async () => {
    const hiddenKeys = [
      "idDocType", "idDoc", "i9", "ssnCardDoc",
      "siaLicenseLevel", "photo", "cv", "trainingCertificates",
    ];
    for (const k of hiddenKeys) await setFieldConfig(k, { hidden: true });

    const body = buildApplicationBody("hidden-omit");
    for (const k of hiddenKeys) delete body[k];

    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(201);

    const row = await fetchApplicationByEmail(body.email as string);
    expect(row).toBeTruthy();
    // Hidden fields persisted as null even though the form no longer collects them.
    expect(row.idDocType).toBeNull();
    expect(row.idDocKey).toBeNull();
    expect(row.i9Data).toBeNull();
    expect(row.ssnCardDocKey).toBeNull();
    expect(row.siaLicenseLevel).toBeNull();
    expect(row.photoKey).toBeNull();
    expect(row.cvKey).toBeNull();
    expect(row.trainingCertificateKeys).toBeNull();
  });

  it("nulls hidden fields even when a stale client still submits values for them", async () => {
    const hiddenKeys = ["idDocType", "siaLicenseLevel", "photo", "i9"];
    for (const k of hiddenKeys) await setFieldConfig(k, { hidden: true });

    // Full body — every value present — but the admin has hidden these fields.
    const body = buildApplicationBody("hidden-stale");
    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(201);

    const row = await fetchApplicationByEmail(body.email as string);
    expect(row).toBeTruthy();
    // Server must drop the slipped-through values rather than persist them.
    expect(row.idDocType).toBeNull();
    expect(row.siaLicenseLevel).toBeNull();
    expect(row.photoKey).toBeNull();
    expect(row.i9Data).toBeNull();
    // A non-hidden field with a value still persists.
    expect(row.cvKey).toBeTruthy();
  });
});

describe("POST /applications — optional built-in fields", () => {
  it("accepts a submission omitting fields the admin marked optional", async () => {
    const optionalKeys = [
      "idDocType", "idDoc", "i9", "ssnCardDoc",
      "siaLicenseLevel", "siaLicenseNumber", "siaLicenseExpiry",
      "photo", "cv", "trainingCertificates", "references",
      "yearsExperience", "previousExperience", "availability",
      "city", "state", "zip", "dateOfBirth", "cityOfBirth", "stateOfBirth", "niNumber",
    ];
    for (const k of optionalKeys) await setFieldConfig(k, { requiredOverride: false });

    // Submit only the five locked core fields.
    const full = buildApplicationBody("optional-omit");
    const body: Record<string, unknown> = {
      firstName: full.firstName,
      lastName: full.lastName,
      email: full.email,
      phone: full.phone,
      address: full.address,
    };

    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(201);

    const row = await fetchApplicationByEmail(body.email as string);
    expect(row).toBeTruthy();
    // Optional + omitted ⇒ null, but the submission itself was accepted.
    expect(row.photoKey).toBeNull();
    expect(row.siaLicenseLevel).toBeNull();
  });

  it("still rejects a submission missing a field that remains required (400)", async () => {
    // Only relax `photo`; `cv` stays required by default.
    await setFieldConfig("photo", { requiredOverride: false });

    const body = buildApplicationBody("required-missing");
    delete body.photo; // allowed (optional)
    delete body.cv; // NOT allowed (still required)

    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.fieldErrors)).toBe(true);
    expect(res.body.fieldErrors.some((e: { field: string }) => e.field === "cv")).toBe(true);
  });
});

describe("PATCH /admin/application-fields/:key — locked core fields", () => {
  const LOCKED = ["firstName", "lastName", "email", "phone", "address"] as const;

  it("drops required/hidden overrides for locked fields but keeps the label", async () => {
    for (const key of LOCKED) {
      const res = await request(app)
        .patch(`/api/admin/application-fields/${key}`)
        .set(authed(ctx.adminToken))
        .send({ labelOverride: `Renamed ${key}`, requiredOverride: false, hidden: true });
      expect(res.status).toBe(200);
      // The merged response forces required+visible regardless of the request.
      expect(res.body.key).toBe(key);
      expect(res.body.required).toBe(true);
      expect(res.body.hidden).toBe(false);
      expect(res.body.locked).toBe(true);
      expect(res.body.label).toBe(`Renamed ${key}`);

      // And the persisted override row never recorded the disallowed bits.
      const [stored] = await db
        .select()
        .from(applicationFieldConfigTable)
        .where(eq(applicationFieldConfigTable.fieldKey, key));
      expect(stored.labelOverride).toBe(`Renamed ${key}`);
      expect(stored.requiredOverride).toBeNull();
      expect(stored.hidden).toBe(false);
    }
  });

  it("applies required/hidden overrides for a non-locked field", async () => {
    const res = await request(app)
      .patch("/api/admin/application-fields/idDocType")
      .set(authed(ctx.adminToken))
      .send({ requiredOverride: false, hidden: true });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe("idDocType");
    expect(res.body.required).toBe(false);
    expect(res.body.hidden).toBe(true);
    expect(res.body.locked).toBe(false);
  });

  it("404s for an unknown field key", async () => {
    const res = await request(app)
      .patch("/api/admin/application-fields/notARealField")
      .set(authed(ctx.adminToken))
      .send({ hidden: true });
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/application-fields/reorder — section scoped", () => {
  function sectionKeys(section: number): string[] {
    return APPLICATION_FIELD_REGISTRY.filter((f) => f.section === section).map((f) => f.key);
  }

  it("accepts a complete permutation of one section's keys", async () => {
    const section = 0; // Personal
    const keys = sectionKeys(section);
    const reversed = [...keys].reverse();

    const res = await request(app)
      .post("/api/admin/application-fields/reorder")
      .set(authed(ctx.adminToken))
      .send({ section, keys: reversed });
    expect(res.status).toBe(200);

    // The effective config for this section now follows the reversed order.
    const effective: Array<{ key: string; section: number }> = res.body;
    const orderedSection0 = effective.filter((f) => f.section === section).map((f) => f.key);
    expect(orderedSection0).toEqual(reversed);
    // Other sections keep their registry order (untouched).
    const orderedSection1 = effective.filter((f) => f.section === 1).map((f) => f.key);
    expect(orderedSection1).toEqual(sectionKeys(1));
  });

  it("rejects keys that belong to a different section (409)", async () => {
    const section = 0;
    const keys = sectionKeys(section);
    // Swap in a key from section 1 — no longer the exact section set.
    const tainted = [...keys.slice(0, -1), sectionKeys(1)[0]];

    const res = await request(app)
      .post("/api/admin/application-fields/reorder")
      .set(authed(ctx.adminToken))
      .send({ section, keys: tainted });
    expect(res.status).toBe(409);
  });

  it("rejects an incomplete section set (409)", async () => {
    const section = 0;
    const keys = sectionKeys(section).slice(0, -1); // drop one

    const res = await request(app)
      .post("/api/admin/application-fields/reorder")
      .set(authed(ctx.adminToken))
      .send({ section, keys });
    expect(res.status).toBe(409);
  });

  it("rejects a section index out of range (400)", async () => {
    const res = await request(app)
      .post("/api/admin/application-fields/reorder")
      .set(authed(ctx.adminToken))
      .send({ section: APPLICATION_FIELD_SECTIONS.length, keys: ["firstName"] });
    expect(res.status).toBe(400);
  });
});
