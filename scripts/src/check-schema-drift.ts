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
 *
 *   Differences the other direction (extra DB columns / indexes / enum values
 *   that exist only in the database) are intentionally ignored — that is not a
 *   release blocker for the test gates and `push` reconciles it separately.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-schema-drift
 *
 * Exit codes: 0 = in sync, 1 = drift detected (or DB unreachable).
 */
import { is } from "drizzle-orm";
import { PgTable, getTableConfig, isPgEnum } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";
import pg from "pg";

interface ExpectedColumn {
  /** Actual database column name. */
  name: string;
  /** Canonical SQL type (whitespace-normalised getSQLType()). */
  type: string;
  /** Whether the column is NOT NULL in code. */
  notNull: boolean;
}

interface ExpectedIndex {
  /** Actual database index name (the explicit name passed to index()). */
  name: string;
}

interface ExpectedTable {
  /** TS identifier exported from the schema barrel (for friendlier output). */
  exportName: string;
  /** Actual database schema (defaults to "public"). */
  dbSchema: string;
  /** Actual database table name. */
  tableName: string;
  columns: ExpectedColumn[];
  indexes: ExpectedIndex[];
}

interface ExpectedEnum {
  /** TS identifier exported from the schema barrel (for friendlier output). */
  exportName: string;
  dbSchema: string;
  /** Postgres enum type name. */
  enumName: string;
  /** Declared values, in code order. */
  values: string[];
}

interface LiveColumn {
  type: string;
  notNull: boolean;
}
type LiveTable = Map<string, LiveColumn>; // column name → metadata.

/**
 * Normalise a SQL type string so the code-declared type and the live DB type
 * compare equal when they are semantically identical. Both `getSQLType()` and
 * Postgres' `format_type()` already produce canonical names; the only cosmetic
 * difference is whitespace inside the modifier parens (drizzle emits
 * `numeric(10, 2)` while `format_type` emits `numeric(10,2)`).
 */
function canonicalType(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "");
}

function collectExpected(): { tables: ExpectedTable[]; enums: ExpectedEnum[] } {
  const tables: ExpectedTable[] = [];
  const enums: ExpectedEnum[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (is(value, PgTable)) {
      const cfg = getTableConfig(value);
      tables.push({
        exportName,
        dbSchema: cfg.schema ?? "public",
        tableName: cfg.name,
        columns: cfg.columns.map((c) => ({
          name: c.name,
          type: canonicalType(c.getSQLType()),
          notNull: c.notNull,
        })),
        indexes: cfg.indexes
          .map((idx) => idx.config.name)
          .filter((n): n is string => Boolean(n))
          .map((name) => ({ name })),
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

async function loadLiveColumns(
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
  }>(
    `SELECT n.nspname AS table_schema,
            c.relname AS table_name,
            a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
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
    });
  }
  return live;
}

async function loadLiveIndexes(
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

async function loadLiveEnums(
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
  try {
    await client.connect();
    // Sequential: a single pg.Client cannot run concurrent queries.
    liveColumns = await loadLiveColumns(client);
    liveIndexes = await loadLiveIndexes(client);
    liveEnums = await loadLiveEnums(client);
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

  const missingTables: ExpectedTable[] = [];
  const missingColumns: string[] = [];
  const typeMismatches: string[] = [];
  const nullabilityMismatches: string[] = [];
  const missingIndexes: string[] = [];
  const missingEnumTypes: string[] = [];
  const missingEnumValues: string[] = [];

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
        missingColumns.push(
          `${key}.${col.name}  (export: ${t.exportName})`,
        );
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
    }
    const liveIdx = liveIndexes.get(key) ?? new Set<string>();
    for (const idx of t.indexes) {
      if (!liveIdx.has(idx.name)) {
        missingIndexes.push(
          `${key}.${idx.name}  (export: ${t.exportName})`,
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
        missingEnumValues.push(
          `${key} → '${v}'  (export: ${e.exportName})`,
        );
      }
    }
  }

  const hasDrift =
    missingTables.length > 0 ||
    missingColumns.length > 0 ||
    typeMismatches.length > 0 ||
    nullabilityMismatches.length > 0 ||
    missingIndexes.length > 0 ||
    missingEnumTypes.length > 0 ||
    missingEnumValues.length > 0;

  if (!hasDrift) {
    const indexCount = expected.reduce((n, t) => n + t.indexes.length, 0);
    console.log(
      `[check-schema-drift] OK — all ${expected.length} schema tables, their ` +
        `columns (types + nullability), ${indexCount} named indexes, and ` +
        `${expectedEnums.length} enum types match the live database.`,
    );
    return;
  }

  console.error(
    "[check-schema-drift] FAIL — the code schema does not match the live database.\n" +
      "The following differences were found between lib/db/src/schema/ and the DB:\n",
  );
  for (const t of missingTables) {
    console.error(
      `  • MISSING TABLE    ${t.dbSchema}.${t.tableName}  (export: ${t.exportName})`,
    );
  }
  for (const line of missingColumns) {
    console.error(`  • MISSING COLUMN   ${line}`);
  }
  for (const line of typeMismatches) {
    console.error(`  • TYPE MISMATCH    ${line}`);
  }
  for (const line of nullabilityMismatches) {
    console.error(`  • NULLABILITY      ${line}`);
  }
  for (const line of missingIndexes) {
    console.error(`  • MISSING INDEX    ${line}`);
  }
  for (const line of missingEnumTypes) {
    console.error(`  • MISSING ENUM     ${line}`);
  }
  for (const line of missingEnumValues) {
    console.error(`  • MISSING ENUM VAL ${line}`);
  }
  console.error(
    "\nThis usually means a schema change was committed without applying it to the\n" +
      "database. Run:\n\n" +
      "  pnpm --filter @workspace/db run push\n\n" +
      "then re-run this check. (Leaving it unapplied makes the `test` and\n" +
      '`security-headers` gates fail later with a cryptic "column ... does not exist",\n' +
      "or — for type/nullability/index drift — only surfaces at runtime in production.)",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[check-schema-drift] crashed:", err);
  process.exit(1);
});
