/**
 * Tests for the pre-publish DATA check (`check-unique-preconditions.ts`).
 *
 * The thing being protected here is a production database: publishing a new
 * uniqueness rule over rows that already violate it is the migration shape that
 * previously resolved as `TRUNCATE ... CASCADE`. So these tests cover
 *   1. every declaration form is enumerated (unique index — including partial,
 *      table-level unique constraint, column-level `.unique()`),
 *   2. the generated query counts the right thing, with the right NULL
 *      semantics and the partial predicate applied,
 *   3. conflicting rows are a HARD failure naming table, rule and group count,
 *   4. a rule that cannot be evaluated warns instead of silently passing,
 *   5. the real `@workspace/db` schema is enumerated (so the partial index that
 *      motivated this check is actually covered).
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { pgTable, text, uuid, timestamp, uniqueIndex, unique, index } from "drizzle-orm/pg-core";
import * as realSchema from "@workspace/db/schema";
import { summarize } from "./check-fork-integrity.js";
import {
  buildViolationQuery,
  checkUniquePreconditions,
  collectUniqueRulesFrom,
  describeRule,
  evaluateUniqueData,
  formatViolation,
  quoteIdent,
  type UniquePrecondition,
  type UniqueRule,
} from "./check-unique-preconditions.js";

// ---------------------------------------------------------------------------
// A synthetic schema covering all three declaration forms.
// ---------------------------------------------------------------------------

const widgetsTable = pgTable(
  "widgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull(),
    slug: text("slug").notNull().unique(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    kind: text("kind"),
  },
  (t) => ({
    ownerIdx: index("widgets_owner_idx").on(t.ownerId),
    oneOpenPerOwner: uniqueIndex("widgets_one_open_per_owner_uniq")
      .on(t.ownerId)
      .where(sql`${t.closedAt} IS NULL`),
    ownerKindUniq: uniqueIndex("widgets_owner_kind_uniq").on(t.ownerId, t.kind),
  }),
);

const gadgetsTable = pgTable(
  "gadgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").notNull(),
    tier: text("tier").notNull(),
  },
  (t) => [unique("gadgets_site_tier_uniq").on(t.siteId, t.tier)],
);

const syntheticSchema = { widgetsTable, gadgetsTable };

function ruleNamed(rules: UniqueRule[], name: string): UniqueRule {
  const hit = rules.find((r) => r.name === name);
  if (!hit) throw new Error(`no rule named "${name}" in [${rules.map((r) => r.name).join(", ")}]`);
  return hit;
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

describe("collectUniqueRulesFrom", () => {
  const rules = collectUniqueRulesFrom(syntheticSchema);

  it("picks up all three declaration forms and nothing else", () => {
    expect(rules.map((r) => r.name).sort()).toEqual([
      "gadgets_site_tier_uniq",
      "widgets_one_open_per_owner_uniq",
      "widgets_owner_kind_uniq",
      "widgets_slug_unique",
    ]);
  });

  it("ignores non-unique indexes", () => {
    expect(rules.some((r) => r.name === "widgets_owner_idx")).toBe(false);
  });

  it("records the partial predicate of a partial unique index", () => {
    const rule = ruleNamed(rules, "widgets_one_open_per_owner_uniq");
    expect(rule.kind).toBe("unique index");
    expect(rule.columns).toEqual(["owner_id"]);
    expect(rule.where).toMatch(/closed_at.*IS NULL/);
    expect(rule.unsupported).toBeUndefined();
  });

  it("records a table-level unique constraint with its key columns", () => {
    const rule = ruleNamed(rules, "gadgets_site_tier_uniq");
    expect(rule.kind).toBe("unique constraint");
    expect(rule.columns).toEqual(["site_id", "tier"]);
    expect(rule.where).toBeNull();
  });

  it("records a column-level .unique()", () => {
    const rule = ruleNamed(rules, "widgets_slug_unique");
    expect(rule.kind).toBe("unique column");
    expect(rule.columns).toEqual(["slug"]);
  });

  it("enumerates the real schema, including the open-time-entry invariant", () => {
    const real = collectUniqueRulesFrom(realSchema as Record<string, unknown>);
    const rule = ruleNamed(real, "time_entries_one_open_per_employee_uniq");
    expect(rule.tableName).toBe("time_entries");
    expect(rule.columns).toEqual(["employee_id"]);
    expect(rule.where).toMatch(/clock_out_time.*IS NULL/);
    // The July 2026 incident's constraint is a table-level unique() — prove
    // that form is enumerated from the real schema too, not just synthetically.
    expect(real.some((r) => r.name === "site_rates_site_level_tier_uniq")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

describe("buildViolationQuery", () => {
  const rules = collectUniqueRulesFrom(syntheticSchema);

  it("counts duplicate groups on the key columns", () => {
    const q = buildViolationQuery(ruleNamed(rules, "gadgets_site_tier_uniq"));
    expect(q).toContain('FROM "public"."gadgets"');
    expect(q).toContain('GROUP BY "site_id", "tier"');
    expect(q).toContain("HAVING count(*) > 1");
    expect(q).toContain("conflicting_groups");
  });

  it("applies the partial predicate, so only in-scope rows can conflict", () => {
    const q = buildViolationQuery(ruleNamed(rules, "widgets_one_open_per_owner_uniq"));
    expect(q).toMatch(/WHERE \(.*closed_at.*IS NULL\)/);
  });

  it("excludes NULL keys, because Postgres NULLs never conflict by default", () => {
    const q = buildViolationQuery(ruleNamed(rules, "widgets_owner_kind_uniq"));
    expect(q).toContain('"owner_id" IS NOT NULL');
    expect(q).toContain('"kind" IS NOT NULL');
  });

  it("keeps NULL keys when the rule declares NULLS NOT DISTINCT", () => {
    const rule: UniqueRule = {
      ...ruleNamed(rules, "widgets_owner_kind_uniq"),
      nullsNotDistinct: true,
    };
    expect(buildViolationQuery(rule)).not.toContain("IS NOT NULL");
  });

  it("issues only read-only SELECTs", () => {
    for (const rule of rules) {
      const q = buildViolationQuery(rule).toUpperCase();
      expect(q.startsWith("SELECT")).toBe(true);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/);
    }
  });

  it("escapes embedded quotes in identifiers", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});

// ---------------------------------------------------------------------------
// Evaluation against a database
// ---------------------------------------------------------------------------

/** A `pg.Client` stand-in that answers each query from a scripted table. */
function fakeClient(answers: Record<string, { groups: number; rows: number } | Error>) {
  const seen: string[] = [];
  const client = {
    seen,
    async query(text: string) {
      seen.push(text);
      const key = Object.keys(answers).find((k) => text.includes(k));
      const answer = key ? answers[key] : { groups: 0, rows: 0 };
      if (answer instanceof Error) throw answer;
      return {
        rows: [{ conflicting_groups: answer.groups, conflicting_rows: answer.rows }],
      };
    },
  };
  return client as unknown as Parameters<typeof checkUniquePreconditions>[0] & {
    seen: string[];
  };
}

const allTables = new Set(["public.widgets", "public.gadgets"]);

describe("checkUniquePreconditions", () => {
  const rules = collectUniqueRulesFrom(syntheticSchema);

  it("reports clean when no group holds duplicates", async () => {
    const out = await checkUniquePreconditions(fakeClient({}), rules, allTables);
    expect(out.every((p) => p.status === "clean")).toBe(true);
  });

  it("reports the offending rule with its conflicting-group count", async () => {
    const out = await checkUniquePreconditions(
      // The partial-index query is the only one mentioning closed_at.
      fakeClient({ closed_at: { groups: 3, rows: 7 } }),
      rules,
      allTables,
    );
    const hit = out.find((p) => p.status === "violating");
    expect(hit?.rule.name).toBe("widgets_one_open_per_owner_uniq");
    expect(hit?.conflictingGroups).toBe(3);
    expect(hit?.conflictingRows).toBe(7);
  });

  it("treats a table this database does not have yet as nothing to conflict with", async () => {
    const out = await checkUniquePreconditions(
      fakeClient({}),
      rules,
      new Set(["public.widgets"]),
    );
    const gadget = out.find((p) => p.rule.tableName === "gadgets");
    expect(gadget?.status).toBe("table-missing");
  });

  it("surfaces a failed query as an error, never as clean", async () => {
    const out = await checkUniquePreconditions(
      fakeClient({ gadgets: new Error("permission denied") }),
      rules,
      allTables,
    );
    const gadget = out.find((p) => p.rule.tableName === "gadgets");
    expect(gadget?.status).toBe("error");
    expect(gadget?.message).toContain("permission denied");
  });

  it("never queries a rule it cannot express, and marks it unsupported", async () => {
    const unsupportedRule: UniqueRule = {
      exportName: "widgetsTable",
      dbSchema: "public",
      tableName: "widgets",
      name: "widgets_expr_uniq",
      kind: "unique index",
      columns: [],
      where: null,
      nullsNotDistinct: false,
      unsupported: "keyed on a SQL expression, not plain columns",
    };
    const client = fakeClient({});
    const out = await checkUniquePreconditions(client, [unsupportedRule], allTables);
    expect(out[0]!.status).toBe("unsupported");
    expect(client.seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function precondition(
  overrides: Partial<UniquePrecondition> & { rule: UniqueRule },
): UniquePrecondition {
  return { status: "clean", conflictingGroups: 0, conflictingRows: 0, ...overrides };
}

describe("evaluateUniqueData", () => {
  const rules = collectUniqueRulesFrom(syntheticSchema);
  const partial = ruleNamed(rules, "widgets_one_open_per_owner_uniq");

  it("passes when every rule is clean", () => {
    const results = evaluateUniqueData({
      source: "DATABASE_URL",
      error: null,
      preconditions: rules.map((rule) => precondition({ rule })),
    });
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("is a REQUIRED failure naming table, rule and group count", () => {
    const results = evaluateUniqueData({
      source: "OVERRIDE_DATABASE_URL",
      error: null,
      preconditions: [
        precondition({
          rule: partial,
          status: "violating",
          conflictingGroups: 2,
          conflictingRows: 5,
        }),
      ],
    });
    const fail = results.find((r) => !r.ok);
    expect(fail?.severity).toBe("required");
    const line = fail?.items?.[0] ?? "";
    expect(line).toContain("public.widgets");
    expect(line).toContain("widgets_one_open_per_owner_uniq");
    expect(line).toContain("2 conflicting group(s)");
    expect(line).toContain("5 row(s)");
  });

  it("fails hard when the database could not be read at all", () => {
    const results = evaluateUniqueData({
      source: "DATABASE_URL",
      error: "could not read the database: connection refused",
      preconditions: [],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.severity).toBe("required");
  });

  // Fails closed: "we could not tell" must never read as "the data is fine".
  // An un-evaluated rule is exactly the one that could rewrite a populated
  // table on publish, so it has to stop the operator like a real violation.
  it.each([
    ["a query that errored (e.g. no SELECT on that table in prod)", "error" as const],
    ["a declaration it cannot express", "unsupported" as const],
  ])("fails hard, with a nonzero exit, on %s", (_label, status) => {
    const results = evaluateUniqueData({
      source: "OVERRIDE_DATABASE_URL",
      error: null,
      preconditions: [
        precondition({ rule: partial, status, message: "permission denied" }),
        precondition({ rule: ruleNamed(rules, "gadgets_site_tier_uniq") }),
      ],
    });
    const fail = results.find((r) => !r.ok);
    expect(fail?.severity).toBe("required");
    expect(fail?.items?.[0]).toContain("permission denied");
    // A clean sibling rule must not rescue the run.
    expect(summarize(results).exitCode).toBe(1);
  });

  it("only exits 0 when every declared rule got an affirmative answer", () => {
    const results = evaluateUniqueData({
      source: "DATABASE_URL",
      error: null,
      preconditions: rules.map((rule) => precondition({ rule })),
    });
    expect(summarize(results).exitCode).toBe(0);
  });

  it("describes a rule with its columns and predicate", () => {
    expect(describeRule(partial)).toMatch(/unique index on \(owner_id\) WHERE .*closed_at/);
    expect(
      formatViolation(
        precondition({ rule: partial, status: "violating", conflictingGroups: 1, conflictingRows: 2 }),
      ),
    ).toContain("widgets_one_open_per_owner_uniq");
  });
});
