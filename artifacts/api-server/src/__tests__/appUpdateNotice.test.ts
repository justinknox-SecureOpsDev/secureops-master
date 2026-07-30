import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, like } from "drizzle-orm";
import request from "supertest";
import { db, usersTable } from "@workspace/db";

// Mock the delivery libs so the routes' selection / summary / stamping logic
// is observable without touching Expo or Twilio. The labelling helper in
// lib/push is exercised separately via vi.importActual (it only touches the
// DB, not Expo).
vi.mock("../lib/push", () => ({
  sendPushToUsers: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/sms", () => ({
  sendSmsToUsers: vi.fn(() =>
    Promise.resolve({ attempted: 1, delivered: 1, skipped: 1, failed: 0 }),
  ),
}));

import app from "../app";
import { signToken } from "../middlewares/auth";
import { sendPushToUsers } from "../lib/push";
import { sendSmsToUsers } from "../lib/sms";
import { CURRENT_EXPO_PROJECT_ID, DEFAULT_IOS_STORE_URL, DEFAULT_ANDROID_STORE_URL } from "../lib/mobileApp";

const mockedPush = vi.mocked(sendPushToUsers);
const mockedSms = vi.mocked(sendSmsToUsers);

const TAG = `appver-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type U = { id: string; token: string };

async function makeUser(
  suffix: string,
  role: string,
  extra: Partial<typeof usersTable.$inferInsert> = {},
): Promise<U> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: TAG,
      lastName: suffix,
      role,
      status: "active",
      smsOptIn: false,
      // insert + sign happen within the same second; defaultNow() would
      // reject the freshly-minted token (iat < tokensValidAfter by ms)
      tokensValidAfter: new Date(0),
      ...extra,
    })
    .returning({ id: usersTable.id, role: usersTable.role, email: usersTable.email });
  return { id: row.id, token: signToken({ userId: row.id, email: row.email, role: row.role }) };
}

const ctx = {} as {
  admin: U;
  officer: U; // never reported → out of date
  currentOfficer: U; // reported the current project → current
  legacyOfficer: U; // reported / labelled a legacy project → out of date
  smsOfficer: U; // opted-in phone, no push token
};

beforeAll(async () => {
  ctx.admin = await makeUser("admin", "admin");
  ctx.officer = await makeUser("officer", "employee");
  ctx.currentOfficer = await makeUser("current", "employee", {
    appProjectId: CURRENT_EXPO_PROJECT_ID,
    appVersion: "1.0.2",
    appPlatform: "ios",
    appReportedAt: new Date(),
    expoPushToken: "ExponentPushToken[current-abc]",
  });
  ctx.legacyOfficer = await makeUser("legacy", "employee", {
    appProjectId: "@legacy/secureops",
    expoPushToken: "ExponentPushToken[legacy-abc]",
  });
  ctx.smsOfficer = await makeUser("sms", "employee", {
    phoneNumber: "+15125550142",
    smsOptIn: true,
  });
});

afterAll(async () => {
  await db.delete(usersTable).where(like(usersTable.email, `${TAG}-%`));
});

beforeEach(() => {
  mockedPush.mockClear();
  mockedSms.mockClear();
});

const authed = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("POST /auth/app-identity", () => {
  it("persists the reported identity against the caller", async () => {
    const res = await request(app)
      .post("/api/auth/app-identity")
      .set(authed(ctx.officer.token))
      .send({ projectId: CURRENT_EXPO_PROJECT_ID, appVersion: "1.0.2", buildNumber: "12", platform: "android" });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, ctx.officer.id));
    expect(row.appProjectId).toBe(CURRENT_EXPO_PROJECT_ID);
    expect(row.appVersion).toBe("1.0.2");
    expect(row.appBuildNumber).toBe("12");
    expect(row.appPlatform).toBe("android");
    expect(row.appReportedAt).not.toBeNull();
    // reset for the roster tests below
    await db
      .update(usersTable)
      .set({ appProjectId: null, appVersion: null, appBuildNumber: null, appPlatform: null, appReportedAt: null })
      .where(eq(usersTable.id, ctx.officer.id));
  });

  it("400s without a projectId", async () => {
    const res = await request(app)
      .post("/api/auth/app-identity")
      .set(authed(ctx.officer.token))
      .send({ appVersion: "1.0.2" });
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/push-token with identity", () => {
  it("stores token and identity together", async () => {
    const res = await request(app)
      .post("/api/auth/push-token")
      .set(authed(ctx.smsOfficer.token))
      .send({ token: "ExponentPushToken[sms-tmp]", projectId: CURRENT_EXPO_PROJECT_ID, appVersion: "1.0.2", platform: "ios" });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, ctx.smsOfficer.id));
    expect(row.expoPushToken).toBe("ExponentPushToken[sms-tmp]");
    expect(row.appProjectId).toBe(CURRENT_EXPO_PROJECT_ID);
    // restore: smsOfficer must stay push-less + unreported for the notice tests
    await db
      .update(usersTable)
      .set({ expoPushToken: null, appProjectId: null, appVersion: null, appPlatform: null, appReportedAt: null })
      .where(eq(usersTable.id, ctx.smsOfficer.id));
  });
});

describe("GET /admin/app-versions", () => {
  it("rejects non-staff roles", async () => {
    const res = await request(app).get("/api/admin/app-versions").set(authed(ctx.officer.token));
    expect(res.status).toBe(403);
  });

  it("classifies current, legacy, and never-reported users", async () => {
    const res = await request(app).get("/api/admin/app-versions").set(authed(ctx.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.currentProjectId).toBe(CURRENT_EXPO_PROJECT_ID);
    expect(res.body.defaults.iosUrl).toBe(DEFAULT_IOS_STORE_URL);
    const byId = new Map((res.body.users as { id: string; onCurrentApp: boolean; appProjectId: string | null }[]).map((u) => [u.id, u]));
    expect(byId.get(ctx.currentOfficer.id)?.onCurrentApp).toBe(true);
    expect(byId.get(ctx.legacyOfficer.id)?.onCurrentApp).toBe(false);
    // never reported ⇒ out of date by definition
    expect(byId.get(ctx.officer.id)?.onCurrentApp).toBe(false);
  });
});

describe("POST /admin/app-update-notice", () => {
  const validBody = () => ({
    userIds: [ctx.officer.id, ctx.legacyOfficer.id, ctx.smsOfficer.id],
    message: "Please install the new SecureOps app from the store.",
    iosUrl: DEFAULT_IOS_STORE_URL,
    androidUrl: DEFAULT_ANDROID_STORE_URL,
  });

  it("rejects non-staff roles", async () => {
    const res = await request(app)
      .post("/api/admin/app-update-notice")
      .set(authed(ctx.officer.token))
      .send(validBody());
    expect(res.status).toBe(403);
    expect(mockedPush).not.toHaveBeenCalled();
  });

  it("rejects non-store links", async () => {
    const res = await request(app)
      .post("/api/admin/app-update-notice")
      .set(authed(ctx.admin.token))
      .send({ ...validBody(), iosUrl: "https://evil.example.com/app" });
    expect(res.status).toBe(400);
    const res2 = await request(app)
      .post("/api/admin/app-update-notice")
      .set(authed(ctx.admin.token))
      .send({ ...validBody(), androidUrl: "http://play.google.com/insecure" });
    expect(res2.status).toBe(400);
    expect(mockedPush).not.toHaveBeenCalled();
  });

  it("sends push+in-app without SMS by default, stamps the users, reports unreachable", async () => {
    const res = await request(app)
      .post("/api/admin/app-update-notice")
      .set(authed(ctx.admin.token))
      .send(validBody());
    expect(res.status).toBe(200);
    expect(mockedPush).toHaveBeenCalledTimes(1);
    const [ids, payload] = mockedPush.mock.calls[0];
    expect(new Set(ids)).toEqual(new Set([ctx.officer.id, ctx.legacyOfficer.id, ctx.smsOfficer.id]));
    expect(payload.data).toMatchObject({ type: "app_update", iosUrl: DEFAULT_IOS_STORE_URL });
    expect(mockedSms).not.toHaveBeenCalled();

    expect(res.body.total).toBe(3);
    expect(res.body.inApp).toBe(3);
    expect(res.body.push).toBe(1); // only legacyOfficer holds a valid token
    expect(res.body.sms).toBeNull();
    // SMS was NOT requested, so the phone-only officer counts as unreachable too
    const unreachableIds = (res.body.unreachable as { id: string }[]).map((u) => u.id);
    expect(new Set(unreachableIds)).toEqual(new Set([ctx.officer.id, ctx.smsOfficer.id]));

    const [stamped] = await db.select().from(usersTable).where(eq(usersTable.id, ctx.officer.id));
    expect(stamped.appUpdateNotifiedAt).not.toBeNull();
  });

  it("includes SMS when requested and excludes SMS-reachable users from unreachable", async () => {
    const res = await request(app)
      .post("/api/admin/app-update-notice")
      .set(authed(ctx.admin.token))
      .send({ ...validBody(), sendSms: true });
    expect(res.status).toBe(200);
    expect(mockedSms).toHaveBeenCalledTimes(1);
    const [, smsBody] = mockedSms.mock.calls[0];
    expect(smsBody).toContain(DEFAULT_IOS_STORE_URL);
    expect(smsBody).toContain(DEFAULT_ANDROID_STORE_URL);
    expect(res.body.sms).toMatchObject({ delivered: 1 });
    const unreachableIds = (res.body.unreachable as { id: string }[]).map((u) => u.id);
    expect(unreachableIds).toEqual([ctx.officer.id]);
  });

  it("degrades cleanly when SMS is not configured (all skipped)", async () => {
    mockedSms.mockResolvedValueOnce({ attempted: 0, delivered: 0, skipped: 3, failed: 0 });
    const res = await request(app)
      .post("/api/admin/app-update-notice")
      .set(authed(ctx.admin.token))
      .send({ ...validBody(), sendSms: true });
    expect(res.status).toBe(200);
    expect(res.body.sms).toMatchObject({ delivered: 0, skipped: 3 });
  });

  it("400s on an empty selection", async () => {
    const res = await request(app)
      .post("/api/admin/app-update-notice")
      .set(authed(ctx.admin.token))
      .send({ ...validBody(), userIds: [] });
    expect(res.status).toBe(400);
  });
});

describe("labelTokensFromProjectSplit", () => {
  it("labels only rows that never self-reported", async () => {
    const actual = await vi.importActual<typeof import("../lib/push")>("../lib/push");
    await actual.labelTokensFromProjectSplit("@legacy/secureops-old", [
      "ExponentPushToken[legacy-abc]", // legacyOfficer: no self-report → relabelled
      "ExponentPushToken[current-abc]", // currentOfficer: self-reported → untouched
    ]);
    const [legacy] = await db.select().from(usersTable).where(eq(usersTable.id, ctx.legacyOfficer.id));
    const [current] = await db.select().from(usersTable).where(eq(usersTable.id, ctx.currentOfficer.id));
    expect(legacy.appProjectId).toBe("@legacy/secureops-old");
    expect(current.appProjectId).toBe(CURRENT_EXPO_PROJECT_ID);
  });
});
