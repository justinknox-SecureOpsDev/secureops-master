import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { inArray, like } from "drizzle-orm";
import { db, usersTable, chatRoomsTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Exercises POST /chat/rooms — the admin "create channel" route used by the
// admin portal (new) and the mobile app. Covers the type allow-list, the
// license-level requirement, per-type join-policy defaults, and the
// admin-only guard. All rows are name-tagged so cleanup scopes precisely.
const TAG = `chat-create-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

let adminId = "";
let officerId = "";
let adminToken = "";
let officerToken = "";

async function makeUser(role: "admin" | "employee", suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      // Epoch watermark so JWT iat (whole-second) is never < tokensValidAfter.
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  adminId = await makeUser("admin", "admin");
  officerId = await makeUser("employee", "officer");
  adminToken = signToken({ userId: adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  officerToken = signToken({ userId: officerId, email: `${TAG}-officer@example.test`, role: "employee" });
});

afterAll(async () => {
  await db.delete(chatRoomsTable).where(like(chatRoomsTable.name, `${TAG}%`));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, officerId].filter(Boolean)));
});

describe("POST /chat/rooms", () => {
  it("admin creates an announcements channel (joinPolicy auto, no slug)", async () => {
    const res = await request(app)
      .post("/api/chat/rooms")
      .set(authed(adminToken))
      .send({ name: `${TAG} Announcements`, type: "announcements" });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("announcements");
    expect(res.body.joinPolicy).toBe("auto");
    expect(res.body.slug).toBeNull();
  });

  it("rejects a license-level channel with no/invalid level (400)", async () => {
    const res = await request(app)
      .post("/api/chat/rooms")
      .set(authed(adminToken))
      .send({ name: `${TAG} BadLevel`, type: "license_level" });
    expect(res.status).toBe(400);
  });

  it("creates a license-level channel with a valid level (auto membership)", async () => {
    const res = await request(app)
      .post("/api/chat/rooms")
      .set(authed(adminToken))
      .send({ name: `${TAG} Level3`, type: "license_level", licenseLevel: 3 });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("license_level");
    expect(res.body.licenseLevel).toBe(3);
    expect(res.body.joinPolicy).toBe("auto");
  });

  it("creates a city channel defaulting to request-to-join", async () => {
    const res = await request(app)
      .post("/api/chat/rooms")
      .set(authed(adminToken))
      .send({ name: `${TAG} Dallas`, type: "city", city: "Dallas" });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("city");
    expect(res.body.city).toBe("Dallas");
    expect(res.body.joinPolicy).toBe("request");
  });

  it("creates an elite channel defaulting to invite-only", async () => {
    const res = await request(app)
      .post("/api/chat/rooms")
      .set(authed(adminToken))
      .send({ name: `${TAG} Elite`, type: "elite" });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("elite");
    expect(res.body.joinPolicy).toBe("invite");
  });

  it("aliases the mobile legacy 'general' type to announcements", async () => {
    const res = await request(app)
      .post("/api/chat/rooms")
      .set(authed(adminToken))
      .send({ name: `${TAG} MobileGeneral`, type: "general" });
    expect(res.status).toBe(201);
    // 'general' resolves to admins-only via resolveRoomMembers; announcements
    // resolves to everyone — so mobile channels must be stored as the latter.
    expect(res.body.type).toBe("announcements");
    expect(res.body.joinPolicy).toBe("auto");
  });

  it("derives join policy from type, ignoring a caller override", async () => {
    const res = await request(app)
      .post("/api/chat/rooms")
      .set(authed(adminToken))
      // City channels are request-to-join; a caller asking for 'auto' must not
      // be able to widen access, since membership is type-driven server-side.
      .send({ name: `${TAG} ForcedAuto`, type: "city", city: "Austin", joinPolicy: "auto" });
    expect(res.status).toBe(201);
    expect(res.body.joinPolicy).toBe("request");
  });

  it("rejects an unsupported channel type (400)", async () => {
    const res = await request(app)
      .post("/api/chat/rooms")
      .set(authed(adminToken))
      .send({ name: `${TAG} BadType`, type: "site" });
    expect(res.status).toBe(400);
  });

  it("requires a name (400)", async () => {
    const res = await request(app)
      .post("/api/chat/rooms")
      .set(authed(adminToken))
      .send({ type: "announcements" });
    expect(res.status).toBe(400);
  });

  it("forbids non-admins from creating channels (403)", async () => {
    const res = await request(app)
      .post("/api/chat/rooms")
      .set(authed(officerToken))
      .send({ name: `${TAG} Forbidden`, type: "announcements" });
    expect(res.status).toBe(403);
  });
});
