/**
 * Pre-publish DATA check — will the uniqueness rules declared in
 * `lib/db/src/schema/` be satisfiable by the rows already in this database?
 *
 * Why this exists:
 *   Replit's publish flow diffs the DEV database against the PROD database and
 *   applies the result BEFORE the build. Adding a uniqueness rule (a
 *   `uniqueIndex(...)`, a `unique(...)` table constraint, or a column-level
 *   `.unique()`) to a table that already holds rows is the single most
 *   dangerous migration shape in this stack: in July 2026 exactly that shape
 *   resolved as `TRUNCATE ... CASCADE` and destroyed four populated production
 *   tables, which had to be recovered by a support-run point-in-time restore.
 *   See `.agents/memory/replit-publish-migration-truncate.md` and
 *   `.agents/memory/site-rates-unique-migration-pattern.md`.
 *
 *   On the master template a new uniqueness rule is only merged after dev and
 *   prod have been verified duplicate-free by hand. On a customer fork nobody
 *   does that — the operator merges code, runs `db push`, and republishes. This
 *   check is the step that catches it, before the publish that would otherwise
 *   rewrite the table.
 *
 * What it does:
 *   Enumerates every uniqueness rule declared in the Drizzle schema and, for
 *   each one, asks the connected database whether it ALREADY contains rows that
 *   the rule would reject — grouping on the rule's key columns, honouring its
 *   partial `WHERE` clause and its NULL semantics. Every statement it runs is a
 *   read-only `SELECT`, so it is safe to point at a customer's PRODUCTION
 *   database.
 *
 * Pointing it at a database:
 *   It uses `OVERRIDE_DATABASE_URL` when set, otherwise `DATABASE_URL`. Run it
 *   bare against the tenant's dev DB, and with `OVERRIDE_DATABASE_URL=<prod
 *   connection string>` against their prod DB before publishing.
 */
import { is, SQL } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";
import type pg from "pg";
import type { CheckResult } from "./check-result.js";

const dialect = new PgDialect();

/** Where a uniqueness rule was declared in the Drizzle schema. */
export type UniqueRuleKind =
  | "unique index"
  | "unique constraint"
  | "unique column";

/** One uniqueness rule declared in `lib/db/src/schema/`. */
export interface UniqueRule {
  /** TS identifier exported from the schema barrel (for friendlier output). */
  exportName: string;
  dbSchema: string;
  tableName: string;
  /** The rule's database object name (index / constraint name). */
  name: string;
  kind: UniqueRuleKind;
  /** Key column names, in declaration order. */
  columns: string[];
  /** Rendered partial-index predicate, or null when the rule covers all rows. */
  where: string | null;
  /** When true, two NULLs conflict (Postgres `NULLS NOT DISTINCT`). */
  nullsNotDistinct: boolean;
  /**
   * Set when the rule cannot be turned into a counting query (e.g. it is keyed
   * on a SQL expression rather than plain columns, or its predicate carries
   * bound parameters). Such a rule is reported as un-checkable rather than
   * silently treated as clean.
   */
  unsupported?: string;
}

/** Quote a Postgres identifier for safe interpolation. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Render a declared partial-index predicate to SQL text, or report why it
 * cannot be used. Predicates with bound parameters are rejected rather than
 * inlined: a wrong inlining would silently narrow the check.
 */
function renderPredicate(where: unknown): { sql: string } | { unsupported: string } {
  if (!is(where, SQL)) return { unsupported: "predicate is not a SQL expression" };
  const query = dialect.sqlToQuery(where);
  if (query.params.length > 0) {
    return { unsupported: "predicate carries bound parameters" };
  }
  return { sql: query.sql };
}

/**
 * Collect every uniqueness rule from any Drizzle schema-shaped object (a record
 * of exported `pgTable` values). Parameterised so tests can feed a synthetic
 * schema instead of the real `@workspace/db` barrel.
 *
 * All three declaration forms are covered, because all three produce the same
 * dangerous migration against a populated table:
 *   - `uniqueIndex("name").on(cols)` (optionally `.where(...)`),
 *   - `unique("name").on(cols)` as a table constraint,
 *   - a column-level `.unique()`.
 */
export function collectUniqueRulesFrom(
  schemaObj: Record<string, unknown>,
): UniqueRule[] {
  const rules: UniqueRule[] = [];
  for (const [exportName, value] of Object.entries(schemaObj)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    const dbSchema = cfg.schema ?? "public";
    const base = { exportName, dbSchema, tableName: cfg.name };

    for (const idx of cfg.indexes) {
      const c = idx.config as {
        name?: string;
        unique?: boolean;
        columns?: unknown[];
        where?: unknown;
      };
      if (!c.unique || !c.name) continue;
      const columns: string[] = [];
      let unsupported: string | undefined;
      for (const col of c.columns ?? []) {
        const name = (col as { name?: unknown })?.name;
        if (typeof name === "string") columns.push(name);
        else unsupported = "keyed on a SQL expression, not plain columns";
      }
      let where: string | null = null;
      if (c.where !== undefined && c.where !== null) {
        const rendered = renderPredicate(c.where);
        if ("sql" in rendered) where = rendered.sql;
        else unsupported ??= rendered.unsupported;
      }
      rules.push({
        ...base,
        name: c.name,
        kind: "unique index",
        columns,
        where,
        nullsNotDistinct: Boolean(
          (idx.config as { nullsNotDistinct?: boolean }).nullsNotDistinct,
        ),
        ...(unsupported ? { unsupported } : {}),
      });
    }

    for (const uc of cfg.uniqueConstraints) {
      rules.push({
        ...base,
        name: uc.name ?? `${cfg.name}_unique`,
        kind: "unique constraint",
        columns: uc.columns.map((c) => c.name),
        where: null,
        nullsNotDistinct: Boolean(
          (uc as { nullsNotDistinct?: boolean }).nullsNotDistinct,
        ),
      });
    }

    for (const col of cfg.columns) {
      const c = col as unknown as { isUnique?: boolean; uniqueName?: string };
      if (!c.isUnique) continue;
      rules.push({
        ...base,
        name: c.uniqueName ?? `${cfg.name}_${col.name}_unique`,
        kind: "unique column",
        columns: [col.name],
        where: null,
        nullsNotDistinct: false,
      });
    }
  }
  return rules.sort(
    (a, b) =>
      a.tableName.localeCompare(b.tableName) || a.name.localeCompare(b.name),
  );
}

/** Human-readable one-liner describing what a rule requires. */
export function describeRule(rule: UniqueRule): string {
  return (
    `${rule.kind} on (${rule.columns.join(", ")})` +
    (rule.where ? ` WHERE ${rule.where}` : "")
  );
}

/**
 * Build the read-only counting query for one rule: how many key groups already
 * hold more than one row, and how many rows are in those groups.
 *
 * NULL semantics follow Postgres: by default NULL keys never conflict, so rows
 * with a NULL in any key column are excluded. A rule declared
 * `NULLS NOT DISTINCT` keeps them, because there two NULLs DO conflict.
 */
export function buildViolationQuery(rule: UniqueRule): string {
  const table = `${quoteIdent(rule.dbSchema)}.${quoteIdent(rule.tableName)}`;
  const cols = rule.columns.map(quoteIdent);
  const conditions: string[] = [];
  if (rule.where) conditions.push(`(${rule.where})`);
  if (!rule.nullsNotDistinct) {
    for (const c of cols) conditions.push(`${c} IS NOT NULL`);
  }
  const whereSql =
    conditions.length > 0 ? `\n       WHERE ${conditions.join("\n         AND ")}` : "";
  return (
    `SELECT count(*)::int AS conflicting_groups,\n` +
    `       COALESCE(sum(n), 0)::int AS conflicting_rows\n` +
    `  FROM (SELECT count(*) AS n\n` +
    `          FROM ${table}${whereSql}\n` +
    `         GROUP BY ${cols.join(", ")}\n` +
    `        HAVING count(*) > 1) g`
  );
}

export type PreconditionStatus =
  | "clean"
  | "violating"
  | "table-missing"
  | "unsupported"
  | "error";

/** The verdict for one uniqueness rule against one database. */
export interface UniquePrecondition {
  rule: UniqueRule;
  status: PreconditionStatus;
  /** Number of key groups holding duplicate rows (0 unless violating). */
  conflictingGroups: number;
  /** Total rows inside those groups (0 unless violating). */
  conflictingRows: number;
  /** Why the rule could not be evaluated (`unsupported` / `error` only). */
  message?: string;
}

/** Everything the fork-integrity report needs about the connected database. */
export interface UniqueDataFacts {
  /** Which env var supplied the connection string, for the printed header. */
  source: string;
  /** Set when the database could not be reached/read at all. */
  error: string | null;
  preconditions: UniquePrecondition[];
}

/** The tables that actually exist in the connected database. */
export async function loadExistingTables(
  client: pg.Client,
): Promise<Set<string>> {
  const { rows } = await client.query<{ table_schema: string; table_name: string }>(
    `SELECT n.nspname AS table_schema, c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  );
  return new Set(rows.map((r) => `${r.table_schema}.${r.table_name}`));
}

/**
 * Evaluate every rule against the connected database. Read-only: one `SELECT`
 * per rule, run sequentially because a single `pg.Client` cannot multiplex.
 *
 * A rule whose table does not exist yet is `table-missing`, not a violation —
 * the table will be created empty by the same publish, so there is nothing to
 * conflict with.
 */
export async function checkUniquePreconditions(
  client: pg.Client,
  rules: UniqueRule[],
  existingTables: Set<string>,
): Promise<UniquePrecondition[]> {
  const out: UniquePrecondition[] = [];
  for (const rule of rules) {
    if (rule.unsupported) {
      out.push({
        rule,
        status: "unsupported",
        conflictingGroups: 0,
        conflictingRows: 0,
        message: rule.unsupported,
      });
      continue;
    }
    if (rule.columns.length === 0) {
      out.push({
        rule,
        status: "unsupported",
        conflictingGroups: 0,
        conflictingRows: 0,
        message: "no key columns could be resolved",
      });
      continue;
    }
    if (!existingTables.has(`${rule.dbSchema}.${rule.tableName}`)) {
      out.push({
        rule,
        status: "table-missing",
        conflictingGroups: 0,
        conflictingRows: 0,
      });
      continue;
    }
    try {
      const { rows } = await client.query<{
        conflicting_groups: number;
        conflicting_rows: number;
      }>(buildViolationQuery(rule));
      const groups = Number(rows[0]?.conflicting_groups ?? 0);
      const rowCount = Number(rows[0]?.conflicting_rows ?? 0);
      out.push({
        rule,
        status: groups > 0 ? "violating" : "clean",
        conflictingGroups: groups,
        conflictingRows: rowCount,
      });
    } catch (err) {
      out.push({
        rule,
        status: "error",
        conflictingGroups: 0,
        conflictingRows: 0,
        message: (err as Error).message,
      });
    }
  }
  return out;
}

/** One report line for a rule the data already violates. */
export function formatViolation(p: UniquePrecondition): string {
  return (
    `${p.rule.dbSchema}.${p.rule.tableName}  ${p.rule.name}  ` +
    `[${describeRule(p.rule)}]  — ${p.conflictingGroups} conflicting group(s), ` +
    `${p.conflictingRows} row(s)  (export: ${p.rule.exportName})`
  );
}

/**
 * Turn the collected database facts into report checks.
 *
 * This check fails CLOSED. A rule the existing rows already violate is a
 * REQUIRED failure, obviously — but so is a rule that could not be evaluated
 * (an unsupported declaration, or a query that errored, e.g. a prod role
 * without SELECT on that table). "We could not tell" is not the same as "the
 * data is fine", and the whole point of this gate is that the operator must not
 * be able to publish without an affirmative answer for every declared rule.
 */
export function evaluateUniqueData(facts: UniqueDataFacts): CheckResult[] {
  const area = "Pre-publish data";
  if (facts.error !== null) {
    return [
      {
        area,
        name: "the database can be read to verify uniqueness rules",
        severity: "required",
        ok: false,
        detail: `${facts.error} (connection from ${facts.source})`,
      },
    ];
  }

  const results: CheckResult[] = [];
  const violating = facts.preconditions.filter((p) => p.status === "violating");
  const checked = facts.preconditions.filter(
    (p) => p.status === "clean" || p.status === "violating",
  );
  const missing = facts.preconditions.filter((p) => p.status === "table-missing");
  const uncheckable = facts.preconditions.filter(
    (p) => p.status === "unsupported" || p.status === "error",
  );

  results.push({
    area,
    name: "no existing rows violate a uniqueness rule declared in the schema",
    severity: "required",
    ok: violating.length === 0,
    detail:
      violating.length === 0
        ? `${checked.length} rule(s) checked against ${facts.source}` +
          (missing.length > 0
            ? `, ${missing.length} on table(s) this database does not have yet`
            : "")
        : `${violating.length} rule(s) would be rejected by rows this database ALREADY holds — ` +
          "publishing this schema over that data is the migration shape that " +
          "previously resolved as TRUNCATE ... CASCADE and destroyed live tables",
    items: violating.length > 0 ? violating.map(formatViolation) : undefined,
  });

  if (uncheckable.length > 0) {
    results.push({
      area,
      name: "every declared uniqueness rule could be evaluated",
      severity: "required",
      ok: false,
      detail:
        `${uncheckable.length} rule(s) could not be checked against ${facts.source} — ` +
        "this check does not pass on \"we could not tell\": an unevaluated rule is " +
        "exactly the one that could rewrite a populated table on publish",
      items: uncheckable.map(
        (p) =>
          `${p.rule.dbSchema}.${p.rule.tableName}  ${p.rule.name}  [${describeRule(p.rule)}]  — ${p.message ?? "unknown reason"}`,
      ),
    });
  }

  return results;
}

/** The remediation text printed under a pre-publish data failure. */
export const UNIQUE_VIOLATION_ADVICE =
  "Adding a uniqueness rule to a POPULATED production table is the single most\n" +
  "dangerous migration in this stack. Replit's publish diffs the dev database\n" +
  "against the prod database and applies the result before the build; against\n" +
  "conflicting rows that has already resolved as TRUNCATE ... CASCADE and\n" +
  "destroyed live tables.\n\n" +
  "Do NOT publish. For each rule listed above, in the affected database:\n" +
  "  1. Find the duplicates (GROUP BY the listed key columns, HAVING count(*) > 1)\n" +
  "     and merge or delete them until the group count is zero.\n" +
  "  2. Re-run this check against that same database and confirm it passes.\n" +
  "  3. In the PROD Database pane, create the index/constraint yourself, with the\n" +
  "     EXACT name listed above, so the publish diff for that table is empty and\n" +
  "     the migration has nothing to rewrite.\n\n" +
  "A rule reported as un-evaluated fails for the same reason: this check will not\n" +
  "pass on \"we could not tell\". Grant the connecting role SELECT on that table (or\n" +
  "run the group-by by hand in the Database pane) and get an affirmative answer\n" +
  "before publishing.\n" +
  "See docs/update-existing-customer-runbook.md and\n" +
  ".agents/memory/site-rates-unique-migration-pattern.md.";
