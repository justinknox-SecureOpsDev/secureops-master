/**
 * Schema-drift guard: detect when the code-defined Drizzle schema no longer
 * matches the live database — i.e. something in `lib/db/src/schema/` was never
 * applied with `pnpm --filter @workspace/db run push`.
 *
 * Why this exists:
 *   The `typecheck` gate rebuilds types from the schema source, so it stays
 *   green even when the migration was forgotten. The problem then only
 *   surfaces deep inside the `test` / `security-headers` gates as a cryptic
 *   `column "..." does not exist` (or worse, only at runtime in production with
 *   a wrong type / nullability / missing index). This check fails fast, before
 *   those gates, with an explicit "run db push" message naming exactly what is
 *   out of sync.
 *
 * What it checks (all against the actual DB names, not the TS identifiers):
 *   - MISSING TABLE   — a table exported from `@workspace/db/schema` is absent.
 *   - MISSING COLUMN  — a column defined in code is absent on an existing table.
 *   - TYPE MISMATCH   — a column exists but its SQL type differs (e.g. the code
 *                       widened `numeric(8,2)` → `numeric(10,2)` or switched
 *                       `text` → `uuid`).
 *   - NULLABILITY     — a column exists but its NOT NULL constraint differs.
 *   - MISSING INDEX   — a named `index()/uniqueIndex()` from the schema has no
 *                       matching index on the live table.
 *   - MISSING ENUM    — a `pgEnum` type is absent, or is missing one of the
 *                       values declared in code.
 *   - MISSING FK      — a `references(() => ..., { onDelete })` relationship has
 *                       no matching foreign-key constraint on the live table
 *                       (so deletes don't cascade / set-null as intended,
 *                       leaving orphaned rows).
 *   - FK ACTION       — the foreign key exists but its ON DELETE action differs
 *                       (e.g. code declares `cascade` but the DB has `no action`).
 *   - MISSING DEFAULT — a column `.default(...)` is absent in the DB, so an
 *                       INSERT that omits the column fails (or writes NULL).
 *   - DEFAULT MISMATCH— the column default exists but differs from code.
 *
 *   Foreign keys are matched by their *definition* (local columns → referenced
 *   table/columns), not by constraint name, so drizzle vs DB auto-naming never
 *   produces a false positive. Default values are normalised so semantically
 *   equal expressions compare equal (e.g. `now()` vs `CURRENT_TIMESTAMP`, and
 *   `'0'::numeric` vs the code literal `"0"`).
 *
 *   Differences the other direction (extra DB columns / indexes / enum values /
 *   foreign keys / defaults that exist only in the database) are intentionally
 *   ignored — that is not a release blocker for the test gates and `push`
 *   reconciles it separately.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-schema-drift
 *
 * Exit codes: 0 = in sync, 1 = drift detected (or DB unreachable).
 */
import { is, getTableName, SQL } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig, isPgEnum } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const dialect = new PgDialect();

/**
 * A column default declared in code. We branch on whether drizzle stored a SQL
 * expression (e.g. `defaultNow()` / `defaultRandom()` / `sql\`...\``) or a plain
 * literal (string / number / boolean / array), because the two compare against
 * the live `pg_get_expr()` text differently.
 */
export type ExpectedDefault =
  | { kind: "expr"; canonical: string; display: string }
  | { kind: "literal"; value: string; display: string };

export interface ExpectedColumn {
  /** Actual database column name. */
  name: string;
  /** Canonical SQL type (whitespace-normalised getSQLType()). */
  type: string;
  /** Whether the column is NOT NULL in code. */
  notNull: boolean;
  /**
   * The DB-level default declared in code, or null when there is none. Note a
   * JS-only `$default(fn)` / `$onUpdate(fn)` does NOT create a DB default, so it
   * is intentionally left null here.
   */
  default?: ExpectedDefault | null;
}

export interface ExpectedIndex {
  /** Actual database index name (the explicit name passed to index()). */
  name: string;
}

export interface ExpectedForeignKey {
  /** Drizzle-generated constraint name — for friendly output only. */
  name: string;
  /**
   * Definition key (local columns → referenced table/columns). FKs are matched
   * on this, not on the constraint name, so drizzle vs DB auto-naming can never
   * yield a false positive.
   */
  defKey: string;
  /** Normalised ON DELETE action: "no action" | "cascade" | "set null" | … */
  onDelete: string;
}

export interface ExpectedTable {
  /** TS identifier exported from the schema barrel (for friendlier output). */
  exportName: string;
  /** Actual database schema (defaults to "public"). */
  dbSchema: string;
  /** Actual database table name. */
  tableName: string;
  columns: ExpectedColumn[];
  indexes: ExpectedIndex[];
  foreignKeys?: ExpectedForeignKey[];
}

export interface ExpectedEnum {
  /** TS identifier exported from the schema barrel (for friendlier output). */
  exportName: string;
  dbSchema: string;
  /** Postgres enum type name. */
  enumName: string;
  /** Declared values, in code order. */
  values: string[];
}

export interface LiveColumn {
  type: string;
  notNull: boolean;
  /** Raw `pg_get_expr()` default expression, or null when the column has none. */
  default: string | null;
}
export type LiveTable = Map<string, LiveColumn>; // column name → metadata.

interface LiveForeignKey {
  /** Live constraint name — for friendly output only. */
  name: string;
  /** Normalised ON DELETE action. */
  onDelete: string;
}
/** key = `${schema}.${table}` → (FK definition key → metadata). */
type LiveForeignKeys = Map<string, Map<string, LiveForeignKey>>;

/**
 * Normalise a SQL type string so the code-declared type and the live DB type
 * compare equal when they are semantically identical. Both `getSQLType()` and
 * Postgres' `format_type()` already produce canonical names; the only cosmetic
 * difference is whitespace inside the modifier parens (drizzle emits
 * `numeric(10, 2)` while `format_type` emits `numeric(10,2)`).
 */
export function canonicalType(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * Normalise a SQL *expression* default (e.g. `now()`, `gen_random_uuid()`) so the
 * code form and the live `pg_get_expr()` form compare equal: lowercase, strip
 * whitespace, and fold the `CURRENT_TIMESTAMP` keyword onto `now()` (Postgres
 * accepts both, and drizzle-kit / the DB may render either).
 */
export function canonicalExpr(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/current_timestamp/g, "now()");
}

/**
 * Reduce a live `pg_get_expr()` literal default to its bare value by removing a
 * trailing `::type` cast (e.g. `'pending'::text` → `'pending'`, `'0'::numeric` →
 * `'0'`) and any surrounding single quotes (`'pending'` → `pending`). Leaves
 * unquoted literals like `false` / `2` untouched.
 */
export function stripDbLiteral(raw: string): string {
  let s = raw.trim();
  // Drop one trailing cast: ::<type> where the type may contain spaces (e.g.
  // "character varying"), quotes, and a precision/scale modifier.
  s = s.replace(/::"?[a-z0-9_ ]+"?(\s*\([0-9, ]*\))?\s*$/i, "").trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/**
 * Build the code-side default descriptor for a column, or null when the column
 * has no DB-level default. A JS-only `$default(fn)` leaves `column.default`
 * undefined (only `defaultFn` is set), so it correctly maps to null here.
 */
export function expectedDefaultFor(rawDefault: unknown): ExpectedDefault | null {
  if (rawDefault === undefined) return null;
  if (is(rawDefault, SQL)) {
    const text = dialect.sqlToQuery(rawDefault).sql;
    return { kind: "expr", canonical: canonicalExpr(text), display: text };
  }
  // Literal: array/object defaults (jsonb) serialise via JSON, everything else
  // (string / number / boolean) via String().
  const value =
    typeof rawDefault === "object" && rawDefault !== null
      ? JSON.stringify(rawDefault)
      : String(rawDefault);
  return { kind: "literal", value, display: value };
}

/** Is `s` a plain numeric literal (so `0` / `0.00` / `2` can compare by value)? */
function isNumericLiteral(s: string): boolean {
  return s.length > 0 && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s.trim());
}

/** Fold a boolean literal to a canonical "true"/"false", or null if not boolean. */
function normalizeBoolLiteral(s: string): string | null {
  switch (s.trim().toLowerCase()) {
    case "true":
    case "t":
      return "true";
    case "false":
    case "f":
      return "false";
    default:
      return null;
  }
}

/**
 * Does the live default (raw pg_get_expr text, or null) match the code default?
 *
 * Literal defaults are compared **case-sensitively** on their bare value:
 * a text / JSON literal such as `'PENDING'` vs `'pending'` (or a JSON key/value
 * case difference) is real drift, NOT a cosmetic one, so we must not fold case.
 * The only normalisation applied is semantically safe: numerics compare by value
 * (`0` == `0.00`) and booleans fold `t`/`f` ↔ `true`/`false`. SQL-expression
 * defaults keep their own whitespace/keyword canonicalisation via canonicalExpr.
 */
export function defaultMatches(expected: ExpectedDefault, live: string | null): boolean {
  if (live === null) return false; // code expects a default, DB has none.
  if (expected.kind === "expr") {
    return canonicalExpr(live) === expected.canonical;
  }
  const liveValue = stripDbLiteral(live);
  if (liveValue === expected.value) return true;
  if (isNumericLiteral(liveValue) && isNumericLiteral(expected.value)) {
    return Number(liveValue) === Number(expected.value);
  }
  const liveBool = normalizeBoolLiteral(liveValue);
  const expectedBool = normalizeBoolLiteral(expected.value);
  if (liveBool !== null && expectedBool !== null) {
    return liveBool === expectedBool;
  }
  return false;
}

/** Map a `pg_constraint.confdeltype` char to the drizzle ON DELETE action text. */
export function confDelTypeToAction(c: string): string {
  switch (c) {
    case "c":
      return "cascade";
    case "n":
      return "set null";
    case "d":
      return "set default";
    case "r":
      return "restrict";
    case "a":
    default:
      return "no action";
  }
}

/** Stable definition key for a foreign key: local cols → referenced table/cols. */
export function fkDefKey(
  localCols: string[],
  foreignSchema: string,
  foreignTable: string,
  foreignCols: string[],
): string {
  return `(${localCols.join(",")}) -> ${foreignSchema}.${foreignTable}(${foreignCols.join(",")})`;
}

/**
 * Build the expected table/enum descriptors from any Drizzle schema-shaped
 * object (a record of exported `pgTable` / `pgEnum` values). Parameterised so
 * tests can feed a synthetic schema instead of the real `@workspace/db` barrel.
 */
export function collectExpectedFrom(schemaObj: Record<string, unknown>): {
  tables: ExpectedTable[];
  enums: ExpectedEnum[];
} {
  const tables: ExpectedTable[] = [];
  const enums: ExpectedEnum[] = [];
  for (const [exportName, value] of Object.entries(schemaObj)) {
    if (is(value, PgTable)) {
      const cfg = getTableConfig(value);
      const dbSchema = cfg.schema ?? "public";
      tables.push({
        exportName,
        dbSchema,
        tableName: cfg.name,
        columns: cfg.columns.map((c) => ({
          name: c.name,
          type: canonicalType(c.getSQLType()),
          notNull: c.notNull,
          default: expectedDefaultFor((c as { default?: unknown }).default),
        })),
        indexes: cfg.indexes
          .map((idx) => idx.config.name)
          .filter((n): n is string => Boolean(n))
          .map((name) => ({ name })),
        foreignKeys: cfg.foreignKeys.map((fk) => {
          const ref = fk.reference();
          const localCols = ref.columns.map((c) => c.name);
          const foreignCfg = getTableConfig(ref.foreignTable);
          const foreignSchema = foreignCfg.schema ?? "public";
          const foreignTable = getTableName(ref.foreignTable);
          const foreignCols = ref.foreignColumns.map((c) => c.name);
          return {
            name: fk.getName(),
            defKey: fkDefKey(localCols, foreignSchema, foreignTable, foreignCols),
            onDelete: fk.onDelete ?? "no action",
          };
        }),
      });
    } else if (isPgEnum(value)) {
      enums.push({
        exportName,
        dbSchema: value.schema ?? "public",
        enumName: value.enumName,
        values: [...value.enumValues],
      });
    }
  }
  return { tables, enums };
}

/** Expected descriptors derived from the real `@workspace/db` schema barrel. */
export function collectExpected(): {
  tables: ExpectedTable[];
  enums: ExpectedEnum[];
} {
  return collectExpectedFrom(schema as Record<string, unknown>);
}

export async function loadLiveColumns(
  client: pg.Client,
): Promise<Map<string, LiveTable>> {
  // key = `${schema}.${table}` → (column name → {type, notNull}).
  // pg_catalog + format_type() gives the exact canonical SQL type (including
  // precision/scale and array suffixes) plus the NOT NULL flag in one pass.
  const { rows } = await client.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    not_null: boolean;
    column_default: string | null;
  }>(
    `SELECT n.nspname AS table_schema,
            c.relname AS table_name,
            a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            pg_get_expr(ad.adbin, ad.adrelid) AS column_default
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad
         ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE c.relkind = 'r'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  );
  const live = new Map<string, LiveTable>();
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`;
    let cols = live.get(key);
    if (!cols) {
      cols = new Map();
      live.set(key, cols);
    }
    cols.set(r.column_name, {
      type: canonicalType(r.data_type),
      notNull: r.not_null,
      default: r.column_default,
    });
  }
  return live;
}

async function loadLiveForeignKeys(
  client: pg.Client,
): Promise<LiveForeignKeys> {
  // For every foreign-key constraint, resolve the local columns, the referenced
  // table, and the referenced columns (ordered to match drizzle's), plus the
  // ON DELETE action char. We key FKs by their definition (not their name) so a
  // differing constraint auto-name never registers as drift.
  const { rows } = await client.query<{
    constraint_name: string;
    table_schema: string;
    table_name: string;
    on_delete: string;
    local_cols: string[];
    foreign_schema: string;
    foreign_table: string;
    foreign_cols: string[];
  }>(
    `SELECT con.conname AS constraint_name,
            ns.nspname AS table_schema,
            cl.relname AS table_name,
            con.confdeltype AS on_delete,
            (SELECT array_agg(att.attname::text ORDER BY u.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute att
                 ON att.attrelid = con.conrelid AND att.attnum = u.attnum
            ) AS local_cols,
            fns.nspname AS foreign_schema,
            fcl.relname AS foreign_table,
            (SELECT array_agg(att.attname::text ORDER BY u.ord)
               FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute att
                 ON att.attrelid = con.confrelid AND att.attnum = u.attnum
            ) AS foreign_cols
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       JOIN pg_class fcl ON fcl.oid = con.confrelid
       JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
      WHERE con.contype = 'f'
        AND ns.nspname NOT IN ('pg_catalog', 'information_schema')`,
  );
  const live: LiveForeignKeys = new Map();
  for (const r of rows) {
    const tableKey = `${r.table_schema}.${r.table_name}`;
    let fks = live.get(tableKey);
    if (!fks) {
      fks = new Map();
      live.set(tableKey, fks);
    }
    const defKey = fkDefKey(
      r.local_cols ?? [],
      r.foreign_schema,
      r.foreign_table,
      r.foreign_cols ?? [],
    );
    fks.set(defKey, {
      name: r.constraint_name,
      onDelete: confDelTypeToAction(r.on_delete),
    });
  }
  return live;
}

export async function loadLiveIndexes(
  client: pg.Client,
): Promise<Map<string, Set<string>>> {
  // key = `${schema}.${table}` → set of index names on that table.
  const { rows } = await client.query<{
    table_schema: string;
    table_name: string;
    index_name: string;
  }>(
    `SELECT n.nspname AS table_schema,
            t.relname AS table_name,
            i.relname AS index_name
       FROM pg_class t
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_index ix ON ix.indrelid = t.oid
       JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE t.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  );
  const live = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`;
    let names = live.get(key);
    if (!names) {
      names = new Set();
      live.set(key, names);
    }
    names.add(r.index_name);
  }
  return live;
}

export async function loadLiveEnums(
  client: pg.Client,
): Promise<Map<string, Set<string>>> {
  // key = `${schema}.${enum type}` → set of enum values.
  const { rows } = await client.query<{
    enum_schema: string;
    enum_name: string;
    enum_value: string;
  }>(
    `SELECT n.nspname AS enum_schema,
            t.typname AS enum_name,
            e.enumlabel AS enum_value
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typtype = 'e'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  );
  const live = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = `${r.enum_schema}.${r.enum_name}`;
    let values = live.get(key);
    if (!values) {
      values = new Set();
      live.set(key, values);
    }
    values.add(r.enum_value);
  }
  return live;
}

/** Structured result of comparing the expected schema against the live DB. */
export interface DriftResult {
  missingTables: ExpectedTable[];
  missingColumns: string[];
  typeMismatches: string[];
  nullabilityMismatches: string[];
  missingIndexes: string[];
  missingEnumTypes: string[];
  missingEnumValues: string[];
  missingDefaults: string[];
  defaultMismatches: string[];
  missingForeignKeys: string[];
  fkActionMismatches: string[];
}

/** True if any drift dimension flagged at least one difference. */
export function hasAnyDrift(r: DriftResult): boolean {
  return (
    r.missingTables.length > 0 ||
    r.missingColumns.length > 0 ||
    r.typeMismatches.length > 0 ||
    r.nullabilityMismatches.length > 0 ||
    r.missingIndexes.length > 0 ||
    r.missingEnumTypes.length > 0 ||
    r.missingEnumValues.length > 0 ||
    r.missingDefaults.length > 0 ||
    r.defaultMismatches.length > 0 ||
    r.missingForeignKeys.length > 0 ||
    r.fkActionMismatches.length > 0
  );
}

/**
 * Pure comparison: diff the code-declared schema (expected tables + enums)
 * against the live database snapshot (the three `loadLive*` maps). No I/O —
 * deterministic and directly unit-testable. Differences in the other direction
 * (extra DB columns / indexes / enum values) are intentionally ignored.
 */
export function computeDrift(
  expected: ExpectedTable[],
  expectedEnums: ExpectedEnum[],
  liveColumns: Map<string, LiveTable>,
  liveIndexes: Map<string, Set<string>>,
  liveEnums: Map<string, Set<string>>,
  liveForeignKeys: LiveForeignKeys = new Map(),
): DriftResult {
  const missingTables: ExpectedTable[] = [];
  const missingColumns: string[] = [];
  const typeMismatches: string[] = [];
  const nullabilityMismatches: string[] = [];
  const missingIndexes: string[] = [];
  const missingEnumTypes: string[] = [];
  const missingEnumValues: string[] = [];
  const missingDefaults: string[] = [];
  const defaultMismatches: string[] = [];
  const missingForeignKeys: string[] = [];
  const fkActionMismatches: string[] = [];

  for (const t of expected) {
    const key = `${t.dbSchema}.${t.tableName}`;
    const liveCols = liveColumns.get(key);
    if (!liveCols) {
      missingTables.push(t);
      continue;
    }
    for (const col of t.columns) {
      const liveCol = liveCols.get(col.name);
      if (!liveCol) {
        missingColumns.push(`${key}.${col.name}  (export: ${t.exportName})`);
        continue;
      }
      if (liveCol.type !== col.type) {
        typeMismatches.push(
          `${key}.${col.name}  code=${col.type}  db=${liveCol.type}  (export: ${t.exportName})`,
        );
      }
      if (liveCol.notNull !== col.notNull) {
        nullabilityMismatches.push(
          `${key}.${col.name}  code=${col.notNull ? "NOT NULL" : "NULLABLE"}  db=${liveCol.notNull ? "NOT NULL" : "NULLABLE"}  (export: ${t.exportName})`,
        );
      }
      // Default check (only when code declares a DB-level default; extra
      // DB-only defaults are ignored, consistent with the other dimensions).
      if (col.default) {
        if (liveCol.default === null) {
          missingDefaults.push(
            `${key}.${col.name}  code default=${col.default.display}  db=(none)  (export: ${t.exportName})`,
          );
        } else if (!defaultMatches(col.default, liveCol.default)) {
          defaultMismatches.push(
            `${key}.${col.name}  code=${col.default.display}  db=${liveCol.default}  (export: ${t.exportName})`,
          );
        }
      }
    }
    const liveIdx = liveIndexes.get(key) ?? new Set<string>();
    for (const idx of t.indexes) {
      if (!liveIdx.has(idx.name)) {
        missingIndexes.push(`${key}.${idx.name}  (export: ${t.exportName})`);
      }
    }
    const liveFks =
      liveForeignKeys.get(key) ?? new Map<string, LiveForeignKey>();
    for (const fk of t.foreignKeys ?? []) {
      const liveFk = liveFks.get(fk.defKey);
      if (!liveFk) {
        missingForeignKeys.push(
          `${key} ${fk.defKey}  ON DELETE ${fk.onDelete}  (constraint: ${fk.name}, export: ${t.exportName})`,
        );
      } else if (liveFk.onDelete !== fk.onDelete) {
        fkActionMismatches.push(
          `${key} ${fk.defKey}  ON DELETE code=${fk.onDelete}  db=${liveFk.onDelete}  (constraint: ${fk.name}, export: ${t.exportName})`,
        );
      }
    }
  }

  for (const e of expectedEnums) {
    const key = `${e.dbSchema}.${e.enumName}`;
    const liveValues = liveEnums.get(key);
    if (!liveValues) {
      missingEnumTypes.push(`${key}  (export: ${e.exportName})`);
      continue;
    }
    for (const v of e.values) {
      if (!liveValues.has(v)) {
        missingEnumValues.push(`${key} → '${v}'  (export: ${e.exportName})`);
      }
    }
  }

  return {
    missingTables,
    missingColumns,
    typeMismatches,
    nullabilityMismatches,
    missingIndexes,
    missingEnumTypes,
    missingEnumValues,
    missingDefaults,
    defaultMismatches,
    missingForeignKeys,
    fkActionMismatches,
  };
}

async function main(): Promise<void> {
  const connectionString =
    process.env.OVERRIDE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      "[check-schema-drift] DATABASE_URL is not set — cannot compare the code\n" +
        "schema against the live database. Provision a database first.",
    );
    process.exit(1);
  }

  const { tables: expected, enums: expectedEnums } = collectExpected();
  if (expected.length === 0) {
    console.error(
      "[check-schema-drift] Found no pg tables exported from @workspace/db/schema — " +
        "this looks like a wiring problem, not an in-sync schema.",
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  let liveColumns: Map<string, LiveTable>;
  let liveIndexes: Map<string, Set<string>>;
  let liveEnums: Map<string, Set<string>>;
  let liveForeignKeys: LiveForeignKeys;
  try {
    await client.connect();
    // Sequential: a single pg.Client cannot run concurrent queries.
    liveColumns = await loadLiveColumns(client);
    liveIndexes = await loadLiveIndexes(client);
    liveEnums = await loadLiveEnums(client);
    liveForeignKeys = await loadLiveForeignKeys(client);
  } catch (err) {
    console.error(
      `[check-schema-drift] Could not read the live database schema: ${
        (err as Error).message
      }`,
    );
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }

  const result = computeDrift(
    expected,
    expectedEnums,
    liveColumns,
    liveIndexes,
    liveEnums,
    liveForeignKeys,
  );

  if (!hasAnyDrift(result)) {
    const indexCount = expected.reduce((n, t) => n + t.indexes.length, 0);
    const fkCount = expected.reduce(
      (n, t) => n + (t.foreignKeys?.length ?? 0),
      0,
    );
    const defaultCount = expected.reduce(
      (n, t) => n + t.columns.filter((c) => c.default).length,
      0,
    );
    console.log(
      `[check-schema-drift] OK — all ${expected.length} schema tables, their ` +
        `columns (types + nullability + ${defaultCount} defaults), ${indexCount} ` +
        `named indexes, ${fkCount} foreign keys (incl. ON DELETE), and ` +
        `${expectedEnums.length} enum types match the live database.`,
    );
    return;
  }

  console.error(
    "[check-schema-drift] FAIL — the code schema does not match the live database.\n" +
      "The following differences were found between lib/db/src/schema/ and the DB:\n",
  );
  for (const t of result.missingTables) {
    console.error(
      `  • MISSING TABLE    ${t.dbSchema}.${t.tableName}  (export: ${t.exportName})`,
    );
  }
  for (const line of result.missingColumns) {
    console.error(`  • MISSING COLUMN   ${line}`);
  }
  for (const line of result.typeMismatches) {
    console.error(`  • TYPE MISMATCH    ${line}`);
  }
  for (const line of result.nullabilityMismatches) {
    console.error(`  • NULLABILITY      ${line}`);
  }
  for (const line of result.missingIndexes) {
    console.error(`  • MISSING INDEX    ${line}`);
  }
  for (const line of result.missingEnumTypes) {
    console.error(`  • MISSING ENUM     ${line}`);
  }
  for (const line of result.missingEnumValues) {
    console.error(`  • MISSING ENUM VAL ${line}`);
  }
  for (const line of result.missingForeignKeys) {
    console.error(`  • MISSING FK       ${line}`);
  }
  for (const line of result.fkActionMismatches) {
    console.error(`  • FK ACTION        ${line}`);
  }
  for (const line of result.missingDefaults) {
    console.error(`  • MISSING DEFAULT  ${line}`);
  }
  for (const line of result.defaultMismatches) {
    console.error(`  • DEFAULT MISMATCH ${line}`);
  }
  console.error(
    "\nThis usually means a schema change was committed without applying it to the\n" +
      "database. Run:\n\n" +
      "  pnpm --filter @workspace/db run push\n\n" +
      "then re-run this check. (Leaving it unapplied makes the `test` and\n" +
      '`security-headers` gates fail later with a cryptic "column ... does not exist",\n' +
      "or — for type/nullability/index/FK/default drift — only surfaces at runtime\n" +
      "in production, e.g. orphaned rows on delete or inserts that omit a defaulted column.)",
  );
  process.exit(1);
}

/**
 * Only run the CLI when this file is executed directly (e.g. via tsx), not when
 * it is imported by a test. Without this guard, importing the module would run
 * `main()` and call `process.exit`, killing the test runner.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("[check-schema-drift] crashed:", err);
    process.exit(1);
  });
}
