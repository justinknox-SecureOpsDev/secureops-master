/**
 * Pure-helper unit tests for the schema-drift release gate
 * (`check-schema-drift.ts`).
 *
 * These lock in the *false-positive protections* that keep the gate from crying
 * wolf on harmless differences (e.g. `now()` vs `CURRENT_TIMESTAMP`,
 * `'0'::numeric` vs literal `0`, drizzle's auto-generated FK constraint names,
 * `onDelete` defaulting to "no action") AND the *false-negative protections*
 * that ensure genuine drift is still reported (a different `onDelete`, a missing
 * default, a different FK target column).
 *
 * The functions under test are pure (no I/O), so they are imported and called
 * directly — no DATABASE_URL, no network, runs under the Vitest `test` gate.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalExpr,
  stripDbLiteral,
  expectedDefaultFor,
  defaultMatches,
  confDelTypeToAction,
  fkDefKey,
  type ExpectedDefault,
} from "./check-schema-drift.js";
import { sql } from "drizzle-orm";

describe("canonicalExpr", () => {
  it("folds CURRENT_TIMESTAMP onto now() (case + keyword)", () => {
    expect(canonicalExpr("CURRENT_TIMESTAMP")).toBe("now()");
    expect(canonicalExpr("current_timestamp")).toBe("now()");
    expect(canonicalExpr("now()")).toBe("now()");
  });

  it("strips whitespace and lowercases", () => {
    expect(canonicalExpr("  GEN_RANDOM_UUID()  ")).toBe("gen_random_uuid()");
    expect(canonicalExpr("now( )")).toBe("now()");
  });

  it("makes now() and CURRENT_TIMESTAMP compare equal", () => {
    expect(canonicalExpr("CURRENT_TIMESTAMP")).toBe(canonicalExpr("now()"));
  });

  it("keeps genuinely different expressions distinct", () => {
    expect(canonicalExpr("now()")).not.toBe(canonicalExpr("gen_random_uuid()"));
  });
});

describe("stripDbLiteral", () => {
  it("drops a trailing type cast", () => {
    expect(stripDbLiteral("'pending'::text")).toBe("pending");
    expect(stripDbLiteral("'0'::numeric")).toBe("0");
  });

  it("drops a cast with a precision/scale modifier", () => {
    expect(stripDbLiteral("'0'::numeric(10,2)")).toBe("0");
    expect(stripDbLiteral("0::numeric(10, 2)")).toBe("0");
  });

  it("drops a cast to a multi-word type", () => {
    expect(stripDbLiteral("'abc'::character varying")).toBe("abc");
    expect(stripDbLiteral("'abc'::character varying(255)")).toBe("abc");
  });

  it("unquotes a single-quoted literal and unescapes doubled quotes", () => {
    expect(stripDbLiteral("'pending'")).toBe("pending");
    expect(stripDbLiteral("'it''s'")).toBe("it's");
  });

  it("leaves unquoted literals untouched", () => {
    expect(stripDbLiteral("false")).toBe("false");
    expect(stripDbLiteral("2")).toBe("2");
  });

  it("strips a cast off a jsonb array/object literal", () => {
    expect(stripDbLiteral("'[]'::jsonb")).toBe("[]");
    expect(stripDbLiteral("'{}'::jsonb")).toBe("{}");
  });
});

describe("expectedDefaultFor", () => {
  it("returns null when there is no DB-level default", () => {
    expect(expectedDefaultFor(undefined)).toBeNull();
  });

  it("descriptors a SQL expression default as kind=expr (canonicalised)", () => {
    const d = expectedDefaultFor(sql`now()`);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("expr");
    if (d!.kind === "expr") {
      expect(d!.canonical).toBe("now()");
    }
  });

  it("canonicalises CURRENT_TIMESTAMP expression defaults", () => {
    const d = expectedDefaultFor(sql`CURRENT_TIMESTAMP`);
    expect(d!.kind).toBe("expr");
    if (d!.kind === "expr") {
      expect(d!.canonical).toBe("now()");
    }
  });

  it("describes a string literal default as kind=literal", () => {
    const d = expectedDefaultFor("pending");
    expect(d).toEqual<ExpectedDefault>({
      kind: "literal",
      value: "pending",
      display: "pending",
    });
  });

  it("stringifies number and boolean literals", () => {
    expect(expectedDefaultFor(0)).toMatchObject({ kind: "literal", value: "0" });
    expect(expectedDefaultFor(false)).toMatchObject({
      kind: "literal",
      value: "false",
    });
  });

  it("JSON-serialises array/object (jsonb) literal defaults", () => {
    expect(expectedDefaultFor([])).toMatchObject({
      kind: "literal",
      value: "[]",
    });
    expect(expectedDefaultFor({ a: 1 })).toMatchObject({
      kind: "literal",
      value: '{"a":1}',
    });
  });
});

describe("defaultMatches", () => {
  const expr = (canonical: string): ExpectedDefault => ({
    kind: "expr",
    canonical,
    display: canonical,
  });
  const lit = (value: string): ExpectedDefault => ({
    kind: "literal",
    value,
    display: value,
  });

  it("returns false when code expects a default but the DB has none", () => {
    expect(defaultMatches(lit("0"), null)).toBe(false);
    expect(defaultMatches(expr("now()"), null)).toBe(false);
  });

  it("matches now() against a CURRENT_TIMESTAMP live default", () => {
    expect(defaultMatches(expr("now()"), "CURRENT_TIMESTAMP")).toBe(true);
    expect(defaultMatches(expr("now()"), "now()")).toBe(true);
  });

  it("matches a literal numeric against a casted live numeric ('0'::numeric)", () => {
    expect(defaultMatches(lit("0"), "'0'::numeric")).toBe(true);
    expect(defaultMatches(lit("0"), "0")).toBe(true);
  });

  it("compares numerics by value (0 == 0.00)", () => {
    expect(defaultMatches(lit("0"), "'0.00'::numeric")).toBe(true);
    expect(defaultMatches(lit("0.00"), "0")).toBe(true);
  });

  it("folds boolean t/f against true/false", () => {
    expect(defaultMatches(lit("false"), "false")).toBe(true);
    expect(defaultMatches(lit("true"), "t")).toBe(true);
    expect(defaultMatches(lit("false"), "f")).toBe(true);
  });

  it("matches a jsonb '[]' default against the casted live form", () => {
    expect(defaultMatches(lit("[]"), "'[]'::jsonb")).toBe(true);
    expect(defaultMatches(lit("{}"), "'{}'::jsonb")).toBe(true);
  });

  it("matches a text literal against its casted live form", () => {
    expect(defaultMatches(lit("pending"), "'pending'::text")).toBe(true);
  });

  it("is case-sensitive for text/JSON literals (real drift, not cosmetic)", () => {
    expect(defaultMatches(lit("pending"), "'PENDING'::text")).toBe(false);
    expect(defaultMatches(lit('{"a":1}'), "'{\"A\":1}'::jsonb")).toBe(false);
  });

  it("flags a genuinely different literal value", () => {
    expect(defaultMatches(lit("pending"), "'active'::text")).toBe(false);
    expect(defaultMatches(lit("0"), "'1'::numeric")).toBe(false);
  });

  it("flags a genuinely different expression", () => {
    expect(defaultMatches(expr("now()"), "gen_random_uuid()")).toBe(false);
  });
});

describe("confDelTypeToAction", () => {
  it("maps every pg confdeltype char to its drizzle action", () => {
    expect(confDelTypeToAction("c")).toBe("cascade");
    expect(confDelTypeToAction("n")).toBe("set null");
    expect(confDelTypeToAction("d")).toBe("set default");
    expect(confDelTypeToAction("r")).toBe("restrict");
    expect(confDelTypeToAction("a")).toBe("no action");
  });

  it("defaults unknown chars to 'no action' (matches drizzle's default)", () => {
    expect(confDelTypeToAction("")).toBe("no action");
    expect(confDelTypeToAction("x")).toBe("no action");
  });
});

describe("fkDefKey", () => {
  it("builds a stable single-column definition key", () => {
    expect(fkDefKey(["user_id"], "public", "users", ["id"])).toBe(
      "(user_id) -> public.users(id)",
    );
  });

  it("builds a composite-column key preserving column order", () => {
    expect(
      fkDefKey(["a", "b"], "public", "other", ["x", "y"]),
    ).toBe("(a,b) -> public.other(x,y)");
  });

  it("produces equal keys regardless of constraint name (name-independent)", () => {
    // The whole point: two FKs with the same definition but different auto-named
    // constraints must collapse to the same key so name differences never drift.
    const code = fkDefKey(["site_id"], "public", "sites", ["id"]);
    const live = fkDefKey(["site_id"], "public", "sites", ["id"]);
    expect(code).toBe(live);
  });

  it("distinguishes a different referenced column (real drift)", () => {
    expect(fkDefKey(["site_id"], "public", "sites", ["id"])).not.toBe(
      fkDefKey(["site_id"], "public", "sites", ["uuid"]),
    );
  });

  it("distinguishes a different referenced table or schema", () => {
    const base = fkDefKey(["x"], "public", "a", ["id"]);
    expect(base).not.toBe(fkDefKey(["x"], "public", "b", ["id"]));
    expect(base).not.toBe(fkDefKey(["x"], "other", "a", ["id"]));
  });
});
