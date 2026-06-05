/**
 * Schema-drift guard: detect when the code-defined Drizzle schema is ahead of
 * the live database — i.e. a table or column exists in `lib/db/src/schema/`
 * but was never applied with `pnpm --filter @workspace/db run push`.
 *
 * Why this exists:
 *   The `typecheck` gate rebuilds types from the schema source, so it stays
 *   green even when the migration was forgotten. The problem then only
 *   surfaces deep inside the `test` / `security-headers` gates as a cryptic
 *   `column "..." does not exist`. This check fails fast, before those gates,
 *   with an explicit "run db push" message naming exactly what is missing.
 *
 * What it checks:
 *   Every pg table exported from `@workspace/db/schema` and each of its
 *   columns must exist in the live database (matched on the actual DB
 *   table/column names, not the TS identifiers). Extra columns that exist in
 *   the DB but not in code are intentionally ignored — that direction is not a
 *   release blocker for the test gates and `push` reconciles it separately.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-schema-drift
 *
 * Exit codes: 0 = in sync, 1 = drift detected (or DB unreachable).
 */
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";
import pg from "pg";

interface ExpectedTable {
  /** TS identifier exported from the schema barrel (for friendlier output). */
  exportName: string;
  /** Actual database schema (defaults to "public"). */
  dbSchema: string;
  /** Actual database table name. */
  tableName: string;
  /** Actual database column names. */
  columns: string[];
}

function collectExpectedTables(): ExpectedTable[] {
  const tables: ExpectedTable[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    tables.push({
      exportName,
      dbSchema: cfg.schema ?? "public",
      tableName: cfg.name,
      columns: cfg.columns.map((c) => c.name),
    });
  }
  return tables;
}

async function loadLiveSchema(
  client: pg.Client,
): Promise<Map<string, Set<string>>> {
  // key = `${table_schema}.${table_name}` → set of column names.
  const { rows } = await client.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_schema, table_name, column_name
       FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`,
  );
  const live = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`;
    let cols = live.get(key);
    if (!cols) {
      cols = new Set<string>();
      live.set(key, cols);
    }
    cols.add(r.column_name);
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

  const expected = collectExpectedTables();
  if (expected.length === 0) {
    console.error(
      "[check-schema-drift] Found no pg tables exported from @workspace/db/schema — " +
        "this looks like a wiring problem, not an in-sync schema.",
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  let live: Map<string, Set<string>>;
  try {
    await client.connect();
    live = await loadLiveSchema(client);
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
  const missingColumns: { table: ExpectedTable; columns: string[] }[] = [];

  for (const t of expected) {
    const key = `${t.dbSchema}.${t.tableName}`;
    const liveCols = live.get(key);
    if (!liveCols) {
      missingTables.push(t);
      continue;
    }
    const absent = t.columns.filter((c) => !liveCols.has(c));
    if (absent.length > 0) missingColumns.push({ table: t, columns: absent });
  }

  if (missingTables.length === 0 && missingColumns.length === 0) {
    console.log(
      `[check-schema-drift] OK — all ${expected.length} schema tables and their ` +
        "columns exist in the live database.",
    );
    return;
  }

  console.error(
    "[check-schema-drift] FAIL — the code schema is ahead of the live database.\n" +
      "The following objects are defined in lib/db/src/schema/ but missing from the DB:\n",
  );
  for (const t of missingTables) {
    console.error(
      `  • MISSING TABLE  ${t.dbSchema}.${t.tableName}  (export: ${t.exportName})`,
    );
  }
  for (const { table, columns } of missingColumns) {
    for (const col of columns) {
      console.error(
        `  • MISSING COLUMN ${table.dbSchema}.${table.tableName}.${col}  (export: ${table.exportName})`,
      );
    }
  }
  console.error(
    "\nThis usually means a schema change was committed without applying it to the\n" +
      "database. Run:\n\n" +
      "  pnpm --filter @workspace/db run push\n\n" +
      "then re-run this check. (Leaving it unapplied makes the `test` and\n" +
      "`security-headers` gates fail later with a cryptic \"column ... does not exist\".)",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[check-schema-drift] crashed:", err);
  process.exit(1);
});
