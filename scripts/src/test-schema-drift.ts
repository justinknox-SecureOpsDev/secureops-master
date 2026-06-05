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
  loadLiveForeignKeys,
  computeDrift,
  hasAnyDrift,
  type ExpectedTable,
  type ExpectedEnum,
  type LiveTable,
  type LiveForeignKeys,
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
    // A DB-level literal default — materialised as `DEFAULT 'pending'` below.
    // Exercises loadLiveColumns' column_default query + defaultMatches.
    status: text("status").default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (t) => [index("widget_name_idx").on(t.name)],
);

// A second table carrying a foreign key (with an ON DELETE action) back to
// widget — materialised as `REFERENCES widget(id) ON DELETE CASCADE` below.
// Exercises loadLiveForeignKeys + the FK / onDelete drift dimensions.
const gadget = s.table("gadget", {
  id: uuid("id").primaryKey(),
  widgetId: uuid("widget_id").references(() => widget.id, {
    onDelete: "cascade",
  }),
});

// The object passed to collectExpectedFrom mirrors a schema barrel.
const syntheticSchema = { widget, gadget, moodEnum };

// ---------------------------------------------------------------------------
// Throwaway DB objects matching the synthetic schema above.
// ---------------------------------------------------------------------------
const client = new pg.Client({ connectionString: CONNECTION });

let liveColumns: Map<string, LiveTable>;
let liveIndexes: Map<string, Set<string>>;
let liveEnums: Map<string, Set<string>>;
let liveForeignKeys: LiveForeignKeys;
let baseTables: ExpectedTable[];
let baseEnums: ExpectedEnum[];

const KEY = `${SCHEMA_NAME}.widget`;
const GADGET_KEY = `${SCHEMA_NAME}.gadget`;
const ENUM_KEY = `${SCHEMA_NAME}.widget_mood`;

/** Deep-clone the baseline expected tables so a mutation can't leak between tests. */
function cloneTables(): ExpectedTable[] {
  return baseTables.map((t) => ({
    ...t,
    columns: t.columns.map((c) => ({ ...c })),
    indexes: t.indexes.map((i) => ({ ...i })),
    foreignKeys: t.foreignKeys?.map((f) => ({ ...f })),
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
       status text DEFAULT 'pending',
       created_at timestamptz,
       CONSTRAINT widget_name_unique UNIQUE (name)
     )`,
  );
  await client.query(
    `CREATE INDEX widget_name_idx ON "${SCHEMA_NAME}".widget (name)`,
  );
  await client.query(
    `CREATE TABLE "${SCHEMA_NAME}".gadget (
       id uuid PRIMARY KEY,
       widget_id uuid REFERENCES "${SCHEMA_NAME}".widget (id) ON DELETE CASCADE
     )`,
  );

  liveColumns = await loadLiveColumns(client);
  liveIndexes = await loadLiveIndexes(client);
  liveEnums = await loadLiveEnums(client);
  liveForeignKeys = await loadLiveForeignKeys(client);

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

  const r = computeDrift(baseTables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
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
  const r = computeDrift(baseTables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
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
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
  assert.equal(r.missingTables.length, 1);
  assert.equal(r.missingTables[0]!.tableName, "ghost");
  assert.equal(hasAnyDrift(r), true);
});

test("drift: MISSING COLUMN is detected", () => {
  const tables = cloneTables();
  tables
    .find((t) => t.tableName === "widget")!
    .columns.push({ name: "ghost_col", type: "text", notNull: false });
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
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
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
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
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
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
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
  assert.equal(r.nullabilityMismatches.length, 1);
  assert.match(r.nullabilityMismatches[0]!, /code=NOT NULL\s+db=NULLABLE/);
  assert.equal(hasAnyDrift(r), true);
});

test("drift: MISSING INDEX is detected", () => {
  const tables = cloneTables();
  tables
    .find((t) => t.tableName === "widget")!
    .indexes.push({ name: "widget_ghost_idx" });
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
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
  const r = computeDrift(baseTables, enums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
  assert.equal(r.missingEnumTypes.length, 1);
  assert.match(r.missingEnumTypes[0]!, /ghost_enum/);
  assert.equal(hasAnyDrift(r), true);
});

test("drift: MISSING ENUM VALUE is detected", () => {
  const enums = cloneEnums();
  enums.find((e) => e.enumName === "widget_mood")!.values.push("angry");
  const r = computeDrift(baseTables, enums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
  assert.equal(r.missingEnumValues.length, 1);
  assert.match(r.missingEnumValues[0]!, new RegExp(`${ENUM_KEY}.+angry`));
  assert.equal(hasAnyDrift(r), true);
});

// ---------------------------------------------------------------------------
// Defaults — exercises loadLiveColumns' column_default query end-to-end.
// ---------------------------------------------------------------------------

test("baseline: column default round-trips with no drift (false-positive guard)", () => {
  // The synthetic `status text DEFAULT 'pending'` was materialised and read
  // back; collectExpectedFrom must record the code default and defaultMatches
  // must treat the live `'pending'::text` as equal — so no default drift.
  const statusCol = baseTables
    .find((t) => t.tableName === "widget")!
    .columns.find((c) => c.name === "status")!;
  assert.ok(statusCol.default, "status should carry a code default");
  assert.equal(statusCol.default!.display, "pending");
  const liveStatus = liveColumns.get(KEY)!.get("status")!;
  assert.match(liveStatus.default ?? "", /'pending'/);

  const r = computeDrift(baseTables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
  assert.equal(r.missingDefaults.length, 0);
  assert.equal(r.defaultMismatches.length, 0);
});

test("drift: MISSING DEFAULT is detected", () => {
  // Code declares a default on a column the DB has none for (qty has no DB
  // default), so an INSERT omitting it would fail / write NULL.
  const tables = cloneTables();
  const qty = tables
    .find((t) => t.tableName === "widget")!
    .columns.find((c) => c.name === "qty")!;
  qty.default = { kind: "literal", value: "0", display: "0" };
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
  assert.equal(r.missingDefaults.length, 1);
  assert.match(r.missingDefaults[0]!, /\.qty\b/);
  assert.match(r.missingDefaults[0]!, /db=\(none\)/);
  assert.equal(hasAnyDrift(r), true);
});

test("drift: DEFAULT MISMATCH is detected", () => {
  // Code default diverges from the live `'pending'` literal.
  const tables = cloneTables();
  const status = tables
    .find((t) => t.tableName === "widget")!
    .columns.find((c) => c.name === "status")!;
  status.default = { kind: "literal", value: "active", display: "active" };
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
  assert.equal(r.defaultMismatches.length, 1);
  assert.match(r.defaultMismatches[0]!, /\.status\b/);
  assert.match(r.defaultMismatches[0]!, /code=active/);
  assert.equal(hasAnyDrift(r), true);
});

// ---------------------------------------------------------------------------
// Foreign keys — exercises loadLiveForeignKeys end-to-end.
// ---------------------------------------------------------------------------

test("baseline: foreign key round-trips with no drift (false-positive guard)", () => {
  // The synthetic gadget.widget_id FK was materialised as
  // `REFERENCES widget(id) ON DELETE CASCADE`; loadLiveForeignKeys must read it
  // back keyed by definition with the cascade action, so no FK drift.
  const gadgetTbl = baseTables.find((t) => t.tableName === "gadget")!;
  assert.equal(gadgetTbl.foreignKeys?.length, 1);
  assert.equal(gadgetTbl.foreignKeys![0]!.onDelete, "cascade");
  const liveFks = liveForeignKeys.get(GADGET_KEY);
  assert.ok(liveFks, "gadget should have a live foreign key");
  assert.equal(liveFks!.get(gadgetTbl.foreignKeys![0]!.defKey)?.onDelete, "cascade");

  const r = computeDrift(baseTables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
  assert.equal(r.missingForeignKeys.length, 0);
  assert.equal(r.fkActionMismatches.length, 0);
});

test("drift: MISSING FK (different referenced target) is detected", () => {
  // Code points the FK at a different target than the DB has, so the live FK
  // (keyed by definition) won't match — reported as a missing foreign key.
  const tables = cloneTables();
  const fk = tables.find((t) => t.tableName === "gadget")!.foreignKeys![0]!;
  fk.defKey = `(widget_id) -> ${SCHEMA_NAME}.widget(name)`; // DB references (id)
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
  assert.equal(r.missingForeignKeys.length, 1);
  assert.match(r.missingForeignKeys[0]!, new RegExp(`${GADGET_KEY}`));
  assert.match(r.missingForeignKeys[0]!, /widget\(name\)/);
  assert.equal(hasAnyDrift(r), true);
});

test("drift: FK ACTION mismatch (onDelete differs) is detected", () => {
  // Same FK definition, but code declares SET NULL while the DB has CASCADE.
  const tables = cloneTables();
  const fk = tables.find((t) => t.tableName === "gadget")!.foreignKeys![0]!;
  fk.onDelete = "set null";
  const r = computeDrift(tables, baseEnums, liveColumns, liveIndexes, liveEnums, liveForeignKeys);
  assert.equal(r.fkActionMismatches.length, 1);
  assert.match(r.fkActionMismatches[0]!, /code=set null/);
  assert.match(r.fkActionMismatches[0]!, /db=cascade/);
  assert.equal(hasAnyDrift(r), true);
});
