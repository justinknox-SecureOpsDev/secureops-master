import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  applicationsTable,
  applicationQuestionsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

/**
 * Regression coverage for the admin form-builder *custom questions* path.
 *
 * The built-in configurable fields are covered by applicationFieldConfig.test.ts.
 * This suite pins the entirely-custom question surface: the admin CRUD endpoints
 * (`/admin/application-questions` create / list / reorder / update / delete) and
 * the public POST /applications custom-answer handling driven by
 * `coerceCustomAnswer` — required-missing rejection, per-type coercion, the
 * denormalized `[{questionId,label,fieldType,value}]` storage shape, and the
 * "disabled questions are ignored" invariant.
 *
 * `application_questions` is a single global table (no per-row tenancy), so each
 * test starts from a clean slate (afterEach wipes it) and the suite snapshots +
 * restores any pre-existing rows around the whole run. The api-server vitest
 * config runs files serially (singleFork), so this global mutation can't race
 * other suites.
 */

const TAG = `customq-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = { adminId: string; adminToken: string };
const ctx = {} as Ctx;

/** Rows present before the suite ran; restored verbatim in afterAll. */
let preexistingQuestions: Array<typeof applicationQuestionsTable.$inferSelect> = [];

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// A complete, valid submission. Built-in file paths use the anonymous-upload
// namespace so isApplicationObjectPath() accepts them. Custom answers are added
// per-test via the `customAnswers` field.
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

async function fetchApplicationByEmail(email: string) {
  const [row] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.email, email.toLowerCase()));
  return row;
}

/** Create a custom question via the admin endpoint and return its API row. */
async function createQuestion(
  body: Record<string, unknown>,
): Promise<{ id: string; [k: string]: unknown }> {
  const res = await request(app)
    .post("/api/admin/application-questions")
    .set(authed(ctx.adminToken))
    .send(body);
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async () => {
  // Snapshot + clear so tests start from an empty question set.
  preexistingQuestions = await db.select().from(applicationQuestionsTable);
  await db.delete(applicationQuestionsTable);

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
  await db.delete(applicationQuestionsTable);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM applications WHERE last_name = ${TAG}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
  // Restore the question table exactly as we found it.
  await db.delete(applicationQuestionsTable);
  if (preexistingQuestions.length > 0) {
    await db.insert(applicationQuestionsTable).values(preexistingQuestions);
  }
});

describe("Admin custom-question CRUD", () => {
  it("creates a question and persists it with defaults + auto sortOrder", async () => {
    const created = await createQuestion({ label: "Why us?", fieldType: "long_text" });
    expect(created.id).toBeTruthy();
    expect(created.label).toBe("Why us?");
    expect(created.fieldType).toBe("long_text");
    expect(created.required).toBe(false); // default
    expect(created.enabled).toBe(true); // default
    expect(created.options).toBeNull();
    expect(created.sortOrder).toBe(0); // first question

    const [stored] = await db
      .select()
      .from(applicationQuestionsTable)
      .where(eq(applicationQuestionsTable.id, created.id));
    expect(stored.label).toBe("Why us?");
    expect(stored.fieldType).toBe("long_text");

    // A second question takes the next sort slot.
    const second = await createQuestion({ label: "Years driving?", fieldType: "number" });
    expect(second.sortOrder).toBe(1);
  });

  it("stores options for select questions", async () => {
    const created = await createQuestion({
      label: "Shift preference",
      fieldType: "select",
      options: ["Day", "Night"],
      required: true,
    });
    expect(created.fieldType).toBe("select");
    expect(created.required).toBe(true);
    expect(created.options).toEqual(["Day", "Night"]);
  });

  it("rejects a dropdown with no options (400)", async () => {
    const res = await request(app)
      .post("/api/admin/application-questions")
      .set(authed(ctx.adminToken))
      .send({ label: "Pick one", fieldType: "select" });
    expect(res.status).toBe(400);
  });

  it("rejects a multiselect with an empty options array (400)", async () => {
    const res = await request(app)
      .post("/api/admin/application-questions")
      .set(authed(ctx.adminToken))
      .send({ label: "Pick many", fieldType: "multiselect", options: [] });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown field type (400)", async () => {
    const res = await request(app)
      .post("/api/admin/application-questions")
      .set(authed(ctx.adminToken))
      .send({ label: "Bad", fieldType: "rating" });
    expect(res.status).toBe(400);
  });

  it("requires admin auth on create (401)", async () => {
    const res = await request(app)
      .post("/api/admin/application-questions")
      .send({ label: "No auth", fieldType: "short_text" });
    expect(res.status).toBe(401);
  });

  it("lists questions (enabled + disabled) in display order", async () => {
    await createQuestion({ label: "First", fieldType: "short_text" });
    await createQuestion({ label: "Second", fieldType: "short_text", enabled: false });
    await createQuestion({ label: "Third", fieldType: "short_text" });

    const res = await request(app)
      .get("/api/admin/application-questions")
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const labels = res.body.map((q: { label: string }) => q.label);
    expect(labels).toEqual(["First", "Second", "Third"]);
    // Disabled rows are included for admins.
    expect(res.body.find((q: { label: string }) => q.label === "Second").enabled).toBe(false);
  });

  it("updates a question's label, required flag, and enabled flag", async () => {
    const created = await createQuestion({ label: "Old", fieldType: "short_text" });
    const res = await request(app)
      .patch(`/api/admin/application-questions/${created.id}`)
      .set(authed(ctx.adminToken))
      .send({ label: "New label", required: true, enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe("New label");
    expect(res.body.required).toBe(true);
    expect(res.body.enabled).toBe(false);
  });

  it("rejects switching a question to select without supplying options (400)", async () => {
    const created = await createQuestion({ label: "Free text", fieldType: "short_text" });
    const res = await request(app)
      .patch(`/api/admin/application-questions/${created.id}`)
      .set(authed(ctx.adminToken))
      .send({ fieldType: "select" });
    expect(res.status).toBe(400);
  });

  it("clears options when a select question is switched to a non-option type", async () => {
    const created = await createQuestion({
      label: "Shift",
      fieldType: "select",
      options: ["Day", "Night"],
    });
    const res = await request(app)
      .patch(`/api/admin/application-questions/${created.id}`)
      .set(authed(ctx.adminToken))
      .send({ fieldType: "short_text" });
    expect(res.status).toBe(200);
    expect(res.body.fieldType).toBe("short_text");
    expect(res.body.options).toBeNull();
  });

  it("404s when updating an unknown question id", async () => {
    const res = await request(app)
      .patch(`/api/admin/application-questions/${randomUUID()}`)
      .set(authed(ctx.adminToken))
      .send({ label: "ghost" });
    expect(res.status).toBe(404);
  });

  it("deletes a question and 404s on re-delete", async () => {
    const created = await createQuestion({ label: "Temp", fieldType: "short_text" });
    const del = await request(app)
      .delete(`/api/admin/application-questions/${created.id}`)
      .set(authed(ctx.adminToken));
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const again = await request(app)
      .delete(`/api/admin/application-questions/${created.id}`)
      .set(authed(ctx.adminToken));
    expect(again.status).toBe(404);
  });
});

describe("POST /admin/application-questions/reorder", () => {
  it("applies a complete permutation of the question set", async () => {
    const a = await createQuestion({ label: "A", fieldType: "short_text" });
    const b = await createQuestion({ label: "B", fieldType: "short_text" });
    const c = await createQuestion({ label: "C", fieldType: "short_text" });

    const res = await request(app)
      .post("/api/admin/application-questions/reorder")
      .set(authed(ctx.adminToken))
      .send({ ids: [c.id, a.id, b.id] });
    expect(res.status).toBe(200);
    expect(res.body.map((q: { label: string }) => q.label)).toEqual(["C", "A", "B"]);
  });

  it("rejects an incomplete set (409)", async () => {
    const a = await createQuestion({ label: "A", fieldType: "short_text" });
    await createQuestion({ label: "B", fieldType: "short_text" });

    const res = await request(app)
      .post("/api/admin/application-questions/reorder")
      .set(authed(ctx.adminToken))
      .send({ ids: [a.id] }); // missing B
    expect(res.status).toBe(409);
  });

  it("rejects ids containing an unknown question (409)", async () => {
    const a = await createQuestion({ label: "A", fieldType: "short_text" });
    const res = await request(app)
      .post("/api/admin/application-questions/reorder")
      .set(authed(ctx.adminToken))
      .send({ ids: [a.id, randomUUID()] });
    expect(res.status).toBe(409);
  });

  it("rejects duplicate ids (400)", async () => {
    const a = await createQuestion({ label: "A", fieldType: "short_text" });
    const res = await request(app)
      .post("/api/admin/application-questions/reorder")
      .set(authed(ctx.adminToken))
      .send({ ids: [a.id, a.id] });
    expect(res.status).toBe(400);
  });
});

describe("POST /applications — custom-answer handling", () => {
  it("rejects a submission missing a required custom answer (400)", async () => {
    const q = await createQuestion({ label: "Have a car?", fieldType: "yes_no", required: true });

    const body = buildApplicationBody("required-missing");
    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.fieldErrors)).toBe(true);
    expect(res.body.fieldErrors.some((e: { field: string }) => e.field === `custom:${q.id}`)).toBe(true);
  });

  it("persists valid answers as [{questionId,label,fieldType,value}] with per-type coercion", async () => {
    const shortQ = await createQuestion({ label: "Nickname", fieldType: "short_text" });
    const numQ = await createQuestion({ label: "Years driving", fieldType: "number" });
    const yesNoQ = await createQuestion({ label: "Have a car?", fieldType: "yes_no" });
    const dateQ = await createQuestion({ label: "Start date", fieldType: "date" });
    const selectQ = await createQuestion({
      label: "Shift",
      fieldType: "select",
      options: ["Day", "Night"],
    });
    const multiQ = await createQuestion({
      label: "Languages",
      fieldType: "multiselect",
      options: ["English", "Spanish", "French"],
    });

    const body = buildApplicationBody("valid-answers");
    body.customAnswers = [
      { questionId: shortQ.id, value: "  Jay  " }, // trimmed
      { questionId: numQ.id, value: "5" }, // coerced to number
      { questionId: yesNoQ.id, value: "yes" }, // coerced to boolean
      { questionId: dateQ.id, value: "2026-01-15" },
      { questionId: selectQ.id, value: "Night" },
      { questionId: multiQ.id, value: ["English", "Spanish"] },
    ];

    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(201);

    const row = await fetchApplicationByEmail(body.email as string);
    expect(row).toBeTruthy();
    const answers = row.customAnswers as Array<{
      questionId: string;
      label: string;
      fieldType: string;
      value: unknown;
    }>;
    const byId = new Map(answers.map((a) => [a.questionId, a]));

    expect(byId.get(shortQ.id)).toMatchObject({ label: "Nickname", fieldType: "short_text", value: "Jay" });
    expect(byId.get(numQ.id)).toMatchObject({ fieldType: "number", value: 5 });
    expect(byId.get(yesNoQ.id)).toMatchObject({ fieldType: "yes_no", value: true });
    expect(byId.get(dateQ.id)).toMatchObject({ fieldType: "date", value: "2026-01-15" });
    expect(byId.get(selectQ.id)).toMatchObject({ fieldType: "select", value: "Night" });
    expect(byId.get(multiQ.id)).toMatchObject({ fieldType: "multiselect", value: ["English", "Spanish"] });
  });

  it("rejects an invalid select selection (400)", async () => {
    const q = await createQuestion({
      label: "Shift",
      fieldType: "select",
      options: ["Day", "Night"],
      required: true,
    });
    const body = buildApplicationBody("bad-select");
    body.customAnswers = [{ questionId: q.id, value: "Graveyard" }];

    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.some((e: { field: string }) => e.field === `custom:${q.id}`)).toBe(true);
  });

  it("drops unknown multiselect choices and keeps the valid ones", async () => {
    const q = await createQuestion({
      label: "Languages",
      fieldType: "multiselect",
      options: ["English", "Spanish"],
    });
    const body = buildApplicationBody("multi-filter");
    body.customAnswers = [{ questionId: q.id, value: ["English", "Klingon"] }];

    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(201);

    const row = await fetchApplicationByEmail(body.email as string);
    const answers = row.customAnswers as Array<{ questionId: string; value: unknown }>;
    const answer = answers.find((a) => a.questionId === q.id);
    expect(answer?.value).toEqual(["English"]);
  });

  it("ignores disabled questions — not required, not persisted", async () => {
    const disabled = await createQuestion({
      label: "Disabled required",
      fieldType: "short_text",
      required: true,
      enabled: false,
    });
    const enabled = await createQuestion({ label: "Active", fieldType: "short_text" });

    // No answer for the disabled (required) question — should still succeed.
    const body = buildApplicationBody("disabled-ignored");
    body.customAnswers = [{ questionId: enabled.id, value: "answered" }];

    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(201);

    const row = await fetchApplicationByEmail(body.email as string);
    const answers = (row.customAnswers as Array<{ questionId: string }>) ?? [];
    expect(answers.some((a) => a.questionId === disabled.id)).toBe(false);
    expect(answers.some((a) => a.questionId === enabled.id)).toBe(true);
  });

  it("omits optional custom questions left unanswered", async () => {
    const q = await createQuestion({ label: "Optional note", fieldType: "long_text" });
    const body = buildApplicationBody("optional-blank");
    // customAnswers omitted entirely.
    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(201);

    const row = await fetchApplicationByEmail(body.email as string);
    const answers = (row.customAnswers as Array<{ questionId: string }>) ?? [];
    expect(answers.some((a) => a.questionId === q.id)).toBe(false);
  });
});

describe("Admin review surfaces — custom answers display", () => {
  type DisplayAnswer = {
    questionId: string;
    label: string;
    fieldType: string;
    value: unknown;
  };

  // Submit one application carrying a full spread of custom-answer types and
  // return both its id and the denormalized answers the server stored.
  async function submitWithAnswers(suffix: string): Promise<{
    appId: string;
    questionIds: { shortQ: string; numQ: string; selectQ: string; multiQ: string };
    stored: DisplayAnswer[];
  }> {
    const shortQ = await createQuestion({ label: "Nickname", fieldType: "short_text" });
    const numQ = await createQuestion({ label: "Years driving", fieldType: "number" });
    const selectQ = await createQuestion({
      label: "Shift",
      fieldType: "select",
      options: ["Day", "Night"],
    });
    const multiQ = await createQuestion({
      label: "Languages",
      fieldType: "multiselect",
      options: ["English", "Spanish", "French"],
    });

    const body = buildApplicationBody(suffix);
    body.customAnswers = [
      { questionId: shortQ.id, value: "Jay" },
      { questionId: numQ.id, value: "5" },
      { questionId: selectQ.id, value: "Night" },
      { questionId: multiQ.id, value: ["English", "Spanish"] },
    ];
    const post = await request(app).post("/api/applications").send(body);
    expect(post.status).toBe(201);

    const row = await fetchApplicationByEmail(body.email as string);
    return {
      appId: row.id,
      questionIds: { shortQ: shortQ.id, numQ: numQ.id, selectQ: selectQ.id, multiQ: multiQ.id },
      stored: (row.customAnswers as DisplayAnswer[]) ?? [],
    };
  }

  function expectAnswersIntact(answers: DisplayAnswer[], ids: { shortQ: string; numQ: string; selectQ: string; multiQ: string }) {
    const byId = new Map(answers.map((a) => [a.questionId, a]));
    expect(byId.get(ids.shortQ)).toMatchObject({ label: "Nickname", fieldType: "short_text", value: "Jay" });
    expect(byId.get(ids.numQ)).toMatchObject({ label: "Years driving", fieldType: "number", value: 5 });
    expect(byId.get(ids.selectQ)).toMatchObject({ label: "Shift", fieldType: "select", value: "Night" });
    expect(byId.get(ids.multiQ)).toMatchObject({
      label: "Languages",
      fieldType: "multiselect",
      value: ["English", "Spanish"],
    });
  }

  it("returns customAnswers verbatim in the admin list (label/fieldType/value preserved)", async () => {
    const { appId, questionIds } = await submitWithAnswers("admin-list");

    const res = await request(app)
      .get("/api/admin/applications")
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);

    const found = (res.body as Array<{ id: string; customAnswers: DisplayAnswer[] }>).find(
      (a) => a.id === appId,
    );
    expect(found).toBeTruthy();
    expectAnswersIntact(found!.customAnswers, questionIds);
  });

  it("returns customAnswers verbatim in the admin detail view", async () => {
    const { appId, questionIds, stored } = await submitWithAnswers("admin-detail");

    const res = await request(app)
      .get(`/api/admin/applications/${appId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(appId);
    expectAnswersIntact(res.body.customAnswers as DisplayAnswer[], questionIds);
    // The display layer is a pass-through: what HR sees equals what was stored.
    expect(res.body.customAnswers).toEqual(stored);
  });

  it("keeps historical answers readable after the question is later edited", async () => {
    const { appId, questionIds } = await submitWithAnswers("admin-edited");

    // HR renames + relabels the question type after the fact. The applicant's
    // already-submitted answer must keep its original denormalized snapshot.
    const patch = await request(app)
      .patch(`/api/admin/application-questions/${questionIds.shortQ}`)
      .set(authed(ctx.adminToken))
      .send({ label: "Preferred name", fieldType: "long_text" });
    expect(patch.status).toBe(200);

    const res = await request(app)
      .get(`/api/admin/applications/${appId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    // Original snapshot survives the edit — not re-resolved against the live question.
    expectAnswersIntact(res.body.customAnswers as DisplayAnswer[], questionIds);
  });

  it("keeps historical answers readable after the question is later deleted", async () => {
    const { appId, questionIds } = await submitWithAnswers("admin-deleted");

    const del = await request(app)
      .delete(`/api/admin/application-questions/${questionIds.shortQ}`)
      .set(authed(ctx.adminToken));
    expect(del.status).toBe(200);

    // The question no longer exists, but its denormalized answer is still on the
    // application and must surface to reviewers unchanged.
    const res = await request(app)
      .get(`/api/admin/applications/${appId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expectAnswersIntact(res.body.customAnswers as DisplayAnswer[], questionIds);
  });
});
