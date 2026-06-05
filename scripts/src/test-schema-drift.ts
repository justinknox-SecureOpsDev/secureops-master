/**
 * Tests for the schema-drift release gate (`check-schema-drift.ts`).
 *
 * The drift checker is a safety net — if its detection logic silently breaks, a
 * forgotten `db push` (or a wrong type / nullability / index / enum) would slip
 * past the release gates and only surface at runtime in production. These tests
 * lock in the behavior that was verified by hand when the checker was written.
 *
 * Strategy: create a throwaway Postgres schema, materialise a small set of
 * objects in it, then drive the REAL extraction + loaders + comparison:
 *   - `collectExpectedFrom(<synthetic drizzle schema>)` produces the "code" side
 *     exactly the way the gate does for `@workspace/db/schema`.
 *   - `loadLive*` read the throwaway schema back out of `pg_catalog`.
 *   - `computeDrift` / `hasAnyDrift` are the exact functions `main()` uses to
 *     decide its exit code, so asserting `hasAnyDrift === true` is equivalent to
 *     asserting the gate would exit non-zero.
 *
 * Each drift type is injected by diverging the expected (code) side from the
 * materialised DB and asserting it is reported; the false-positive guards
 * (`numeric(10, 2)` whitespace, `.unique()` constraints vs named indexes) are
 * asserted against the in-sync baseline.
 *
 * Requires DATABASE_URL (or OVERRIDE_DATABASE_URL). Creates and drops its own
 * schema, so it never touches application tables.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run test-schema-drift
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  pgSchema,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import {
  canonicalType,
  collectExpectedFrom,
  loadLiveColumns,
  loadLiveIndexes,
  loadLiveEnums,
  computeDrift,
  hasAnyDrift,
  type ExpectedTable,
  type ExpectedEnum,
  type LiveTable,
} from "./check-schema-drift.js";

const CONNECTION =
  process.env.OVERRIDE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

// Unique per run so parallel/repeat runs never collide on the throwaway schema.
const SCHEMA_NAME = `drift_test_${process.pid}_${Math.floor(
  Math.random() * 1e6,
)}`;

// ---------------------------------------------------------------------------
// Synthetic "code" schema. Built exactly like a real lib/db schema module so
// collectExpectedFrom() exercises the same getTableConfig / getSQLType path.
// ---------------------------------------------------------------------------
const s = pgSchema(SCHEMA_NAME);

const moodEnum = s.enum("widget_mood", ["happy", "sad"]);

const widget = s.table(
  "widget",
  {
    id: uuid("id").primaryKey(),
    // `.unique()` → a unique CONSTRAINT (auto-named index in the DB), which
    // collectExpectedFrom must NOT pick up as a named index.
    name: text("name").notNull().unique("widget_name_unique"),
    // numeric(10, 2): drizzle emits "numeric(10, 2)" while Postgres reports
    // "numeric(10,2)" — the whitespace guard must treat them as equal.
    price: numeric("price", { precision: 10, scale: 2 }),
    qty: integer("qty").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (t) => [index("widget_name_idx").on(t.name)],
);

// The object passed to collectExpectedFrom mirrors a schema barrel.
const syntheticSchema = { widget, moodEnum };

// ---------------------------------------------------------------------------
// Throwaway DB objects matching the synthetic schema above.
// ---------------------------------------------------------------------------
const client = new pg.Client({ connectionString: CONNECTION });

let liveColumns: Map<string, LiveTable>;
let liveIndexes: Map<string, Set<string>>;
let liveEnums: Map<string, Set<string>>;
let baseTables: ExpectedTable[];
let baseEnums: ExpectedEnum[];

const KEY = `${SCHEMA_NAME}.widget`;
const ENUM_KEY = `${SCHEMA_NAME}.widget_mood`;

/** Deep-clone the baseline expected tables so a mutation can't leak between tests. */
function cloneTables(): ExpectedTable[] {
  return baseTables.map((t) => ({
    ...t,
    columns: t.columns.map((c) => ({ ...c })),
    indexes: t.indexes.map((i) => ({ ...i })),
  }));
}

function cloneEnums(): ExpectedEnum[] {
  return baseEnums.map((e) => ({ ...e, values: [...e.values] }));
}

before(async () => {
  assert.ok(
    CONNECTION,
    "DATABASE_URL (or OVERRIDE_DATABASE_URL) must be set to run the schema-drift tests",
  );
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`);
  await client.query(`CREATE SCHEMA "${SCHEMA_NAME}"`);
  await client.query(`CREATE TYPE "${SCHEMA_NAME}".widget_mood AS ENUM ('happy', 'sad')`);
  await client.query(
    `CREATE TABLE "${SCHEMA_NAME}".widget (
       id uuid PRIMARY KEY,
       name text NOT NULL,
       price numeric(10, 2),
       qty integer NOT NULL,
       created_at timestamptz,
       CONSTRAINT widget_name_unique UNIQUE (name)
     )`,
  );
  await client.query(
    `CREATE INDEX widget_name_idx ON "${SCHEMA_NAME}".widget (name)`,
  );

  liveColumns = await loadLiveColumns(client);
  liveIndexes = await loadLiveIndexes(client);
  liveEnums = await loadLiveEnums(client);

  const expected = collectExpectedFrom(syntheticSchema);
  baseTables = expected.tables;
  baseEnums = expected.enums;
});

after(async () => {
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`);
  } finally {
    await client.end().catch(() => {});
  }
});

test("baseline: code schema matches the live DB (no drift)", () => {
  // Sanity: the synthetic schema was correctly materialised + read back.
  const tbl = baseTables.find((t) => t.tableName === "widget");
  assert.ok(tbl, "widget table should be collected from the synthetic schema");
  assert.equal(tbl!.dbSchema, SCHEMA_NAME);
  assert.ok(liveColumns.has(KEY), "live columns should include the widget table");

  const r = computeDrift(baseTables, baseEnums, liveColumns, liveIndexes, liveEnums);
  assert.equal(
    hasAnyDrift(r),
    false,
    `expected no drift on the in-sync baseline, got ${JSON.stringify(r, null, 2)}`,
  );
});

test("false-positive guard: numeric(10, 2) == numeric(10,2) (whitespace)", () => {
  // The code side comes from drizzle's getSQLType (emits "numeric(10, 2)").
  const priceCol = baseTables
    .find((t) => t.tableName === "widget")!
    .columns.find((c) => c.name === "price")!;
  // canonicalType has already collapsed the whitespace on the code side; the
  // live side is canonicalised by the loader. They must be byte-equal.
  const liveType = liveColumns.get(KEY)!.get("price")!.type;
  assert.equal(priceCol.type, "numeric(10,2)");
  assert.equal(liveType, "numeric(10,2)");
  assert.equal(canonicalType("numeric(10, 2)"), canonicalType("numeric(10,2)"));
});

test("false-positive guard: .unique() constraint is NOT treated as a named index", () => {
  // The DB has an auto-named index backing the UNIQUE constraint...
  const liveIdx = liveIndexes.get(KEY)!;
  assert.ok(
    [...liveIdx].some((n) => n.includes("widget_name_unique")),
    "the unique constraint should appear as a live index",
  );
  // ...but collectExpectedFrom only records explicit index()/uniqueIndex() names.
  const expectedIdxNames = baseTables
    .find((t) => t.tableName === "widget")!
    .indexes.map((i) => i.name);
  assert.deepEqual(expectedIdxNames, ["widget_name_idx"]);
  // So no MISSING INDEX is reported for the unique constraint.
  const r = computeDrift(baseTables, baseEnums, liveColumns, liveIndexes, liveEnums);
  assert.equal(r.missingIndexes.length, 0);
});

test("drift: MISSING TABLE is detected", () => {
  const tables = cloneTables();
  tables.push({
    exportName: "ghost",
    dbSchema: SCHEMA_NAME,
    tableName: "ghost",
    columns: [{ name: "id", type: "uuid", notNull: true }],
    indexes: [],
  });
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums);
  assert.equal(r.missingTables.length, 1);
  assert.equal(r.missingTables[0]!.tableName, "ghost");
  assert.equal(hasAnyDrift(r), true);
});

test("drift: MISSING COLUMN is detected", () => {
  const tables = cloneTables();
  tables
    .find((t) => t.tableName === "widget")!
    .columns.push({ name: "ghost_col", type: "text", notNull: false });
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums);
  assert.equal(r.missingColumns.length, 1);
  assert.match(r.missingColumns[0]!, /ghost_col/);
  assert.equal(hasAnyDrift(r), true);
});

test("drift: TYPE MISMATCH is detected", () => {
  const tables = cloneTables();
  const qty = tables
    .find((t) => t.tableName === "widget")!
    .columns.find((c) => c.name === "qty")!;
  qty.type = "text"; // code says text, DB is integer
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums);
  assert.equal(r.typeMismatches.length, 1);
  assert.match(r.typeMismatches[0]!, /code=text\s+db=integer/);
  assert.equal(hasAnyDrift(r), true);
});

test("drift: TYPE MISMATCH catches numeric width change", () => {
  const tables = cloneTables();
  const price = tables
    .find((t) => t.tableName === "widget")!
    .columns.find((c) => c.name === "price")!;
  price.type = canonicalType("numeric(8, 2)"); // code narrowed; DB is 10,2
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums);
  assert.equal(r.typeMismatches.length, 1);
  assert.match(r.typeMismatches[0]!, /code=numeric\(8,2\)\s+db=numeric\(10,2\)/);
  assert.equal(hasAnyDrift(r), true);
});

test("drift: NULLABILITY mismatch is detected", () => {
  const tables = cloneTables();
  const price = tables
    .find((t) => t.tableName === "widget")!
    .columns.find((c) => c.name === "price")!;
  price.notNull = true; // code says NOT NULL, DB is nullable
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums);
  assert.equal(r.nullabilityMismatches.length, 1);
  assert.match(r.nullabilityMismatches[0]!, /code=NOT NULL\s+db=NULLABLE/);
  assert.equal(hasAnyDrift(r), true);
});

test("drift: MISSING INDEX is detected", () => {
  const tables = cloneTables();
  tables
    .find((t) => t.tableName === "widget")!
    .indexes.push({ name: "widget_ghost_idx" });
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums);
  assert.equal(r.missingIndexes.length, 1);
  assert.match(r.missingIndexes[0]!, /widget_ghost_idx/);
  assert.equal(hasAnyDrift(r), true);
});

test("drift: MISSING ENUM TYPE is detected", () => {
  const enums = cloneEnums();
  enums.push({
    exportName: "ghostEnum",
    dbSchema: SCHEMA_NAME,
    enumName: "ghost_enum",
    values: ["a", "b"],
  });
  const r = computeDrift(baseTables, enums, liveColumns, liveIndexes, liveEnums);
  assert.equal(r.missingEnumTypes.length, 1);
  assert.match(r.missingEnumTypes[0]!, /ghost_enum/);
  assert.equal(hasAnyDrift(r), true);
});

test("drift: MISSING ENUM VALUE is detected", () => {
  const enums = cloneEnums();
  enums.find((e) => e.enumName === "widget_mood")!.values.push("angry");
  const r = computeDrift(baseTables, enums, liveColumns, liveIndexes, liveEnums);
  assert.equal(r.missingEnumValues.length, 1);
  assert.match(r.missingEnumValues[0]!, new RegExp(`${ENUM_KEY}.+angry`));
  assert.equal(hasAnyDrift(r), true);
});
