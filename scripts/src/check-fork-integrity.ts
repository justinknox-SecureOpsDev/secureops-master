/**
 * Fork-integrity check — prove a CUSTOMER fork is an exact downstream copy of
 * the master revision it claims to be running.
 *
 * Run this INSIDE a customer/tenant repl (never the master), from that repl's
 * own Shell, immediately after `git merge upstream/main` and again as the last
 * gate before republishing — see `docs/update-existing-customer-runbook.md`.
 *
 * Why this exists:
 *   A customer fork is supposed to be read-only downstream code: the only
 *   thing that may differ from master is the customer's own environment file
 *   (`.replit`). When work is done inside a fork (agent tasks, hand edits), the
 *   fork grows its own commits on shared files; the next `git merge
 *   upstream/main` then conflicts on exactly the biggest shared files, and
 *   resolving those by hand splices unrelated handler bodies together. That
 *   damage still typechecks and can still pass tests, so "typecheck + tests are
 *   green" is not evidence the fork is safe to publish. This check compares
 *   content, not compilability.
 *
 * What it checks, all in one run (nothing stops at the first failure):
 *   - MASTER REVISION — the fetched `upstream/main` ref exists AND is an
 *     ancestor of HEAD. A fetch without a merge does not count, which is the
 *     same rule the deployed build identity applies
 *     (`artifacts/api-server/buildVersion.mjs`), so the revision this check
 *     verifies is the revision the live backend reports.
 *   - SHARED CODE — every tracked path whose content differs from that master
 *     revision is listed by path. The customer's `.replit` is the one expected,
 *     allowed difference; anything else differing means the fork carries local
 *     code.
 *   - MERGE CONFLICTS — leftover conflict markers in any tracked text file.
 *   - TENANT ENVIRONMENT — the fork carries its OWN org code (not the master
 *     template's), no `ORG_DIRECTORY`, and no `EXPO_TOKEN` (a fork must never be
 *     able to ship phone-app updates to the whole fleet).
 *   - PRE-PUBLISH DATA — whether the connected database already holds rows that
 *     violate a uniqueness rule declared in `lib/db/src/schema/`. Publishing a
 *     new uniqueness rule over conflicting rows is the migration shape that
 *     previously resolved as `TRUNCATE ... CASCADE` and destroyed four live
 *     tables, so a violation here is a hard failure. Every statement it runs is
 *     a read-only SELECT — see `check-unique-preconditions.ts`.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-fork-integrity
 *
 *   The data check runs against whichever database the environment points at:
 *   `OVERRIDE_DATABASE_URL` when set, otherwise `DATABASE_URL`. Run it bare for
 *   the tenant's dev database, and with `OVERRIDE_DATABASE_URL=<prod connection
 *   string>` to clear their PRODUCTION database before republishing.
 *
 * Exit code 0 — every REQUIRED check passed (RECOMMENDED gaps only warn).
 * Exit code 1 — at least one REQUIRED check failed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as schema from "@workspace/db/schema";
import type { CheckResult, Severity } from "./check-result.js";
import {
  UNIQUE_VIOLATION_ADVICE,
  checkUniquePreconditions,
  collectUniqueRulesFrom,
  evaluateUniqueData,
  loadExistingTables,
  type UniqueDataFacts,
} from "./check-unique-preconditions.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The ref a customer fork fetches the master template into. */
export const UPSTREAM_REF = "refs/remotes/upstream/main";

/** The master template's own org code — must never be a customer's org code. */
export const MASTER_ORG_CODE = "wcsgi";

/**
 * The ONLY path allowed to differ from master in a customer fork: it holds the
 * customer's `[userenv*]` environment blocks (their org code, admin emails,
 * domain). Every other differing path is a finding.
 */
export const ALLOWED_DIVERGENT_PATHS = [".replit"] as const;

/** Env vars that must never exist in a customer fork. */
export const FORBIDDEN_ENV_VARS = ["ORG_DIRECTORY", "EXPO_TOKEN"] as const;

// ---------------------------------------------------------------------------
// Result model (mirrors the reporting style of check-tenant-config.ts)
// ---------------------------------------------------------------------------

export type { CheckResult, Severity } from "./check-result.js";

/** State of the fetched master ref in this checkout. */
export interface UpstreamState {
  /** `refs/remotes/upstream/main` resolves. */
  refPresent: boolean;
  /** Short SHA of that ref, or null when it does not exist. */
  rev: string | null;
  /** The ref is an ancestor of HEAD (i.e. it was actually merged). */
  mergedIntoHead: boolean;
}

/** A leftover merge-conflict marker found in a tracked text file. */
export interface ConflictHit {
  path: string;
  line: number;
  /** The marker text as found (`<<<<<<<`, `=======`, `>>>>>>>`). */
  marker: string;
}

/** Where an environment value came from, for a useful failure detail. */
export type EnvSource = "replit" | "process";

export interface EnvValue {
  value: string;
  source: EnvSource;
}

export interface ForkEnv {
  /** The fork's org code, or null when it is set nowhere. */
  orgCode: EnvValue | null;
  /** Forbidden vars that were found, keyed by var name. */
  forbidden: Record<string, EnvValue>;
}

export interface ForkFacts {
  upstream: UpstreamState;
  /**
   * Tracked paths whose content differs from the master revision, or null when
   * there is no usable master revision to compare against.
   */
  divergentPaths: string[] | null;
  conflicts: ConflictHit[];
  env: ForkEnv;
  /**
   * Uniqueness preconditions read from the connected database, or undefined
   * when the database was not consulted (unit tests of the git/env logic). The
   * CLI always collects it.
   */
  uniqueData?: UniqueDataFacts;
}

export interface ForkVerdict {
  results: CheckResult[];
  /** Differing paths that are expected and allowed (the env file). */
  allowedDifferences: string[];
  /** The master revision this fork was compared against, when resolvable. */
  masterRev: string | null;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * The master revision this fork can be held to. A fetched-but-unmerged
 * `upstream/main` does NOT count — same rule as `buildVersion.mjs`, so this
 * check and the live `/api/version` identity always agree on what "the master
 * revision this fork claims to be on" means.
 */
export function resolveMasterRev(upstream: UpstreamState): string | null {
  if (!upstream.refPresent || !upstream.mergedIntoHead) return null;
  return upstream.rev;
}

/** Is this path allowed to differ from master (the customer's env file)? */
export function isAllowedDivergentPath(p: string): boolean {
  return (ALLOWED_DIVERGENT_PATHS as readonly string[]).includes(p.trim());
}

/** Split differing paths into the expected env file vs real findings. */
export function splitDivergentPaths(paths: string[]): {
  allowed: string[];
  findings: string[];
} {
  const allowed: string[] = [];
  const findings: string[] = [];
  for (const p of paths) {
    if (isAllowedDivergentPath(p)) allowed.push(p);
    else findings.push(p);
  }
  return { allowed, findings };
}

/**
 * Turn the collected facts into the full list of checks. Every area is always
 * evaluated so one run reports everything wrong with the fork, rather than
 * hiding a bad environment behind a bad merge.
 */
export function evaluateFork(facts: ForkFacts): ForkVerdict {
  const results: CheckResult[] = [];
  const masterRev = resolveMasterRev(facts.upstream);

  // ---- Master revision -----------------------------------------------------
  results.push({
    area: "Master revision",
    name: "the master template is fetched as upstream/main",
    severity: "required",
    ok: facts.upstream.refPresent,
    detail: facts.upstream.refPresent
      ? undefined
      : "no upstream/main ref in this repl — add the mirror as `upstream` and `git fetch upstream` before updating",
  });

  if (facts.upstream.refPresent) {
    results.push({
      area: "Master revision",
      name: "the fetched upstream/main is merged into HEAD",
      severity: "required",
      ok: facts.upstream.mergedIntoHead,
      detail: facts.upstream.mergedIntoHead
        ? `this fork is on master revision ${facts.upstream.rev}`
        : `upstream/main (${facts.upstream.rev}) is fetched but NOT an ancestor of HEAD — the merge did not happen (or was aborted), so this fork is still running its old code`,
    });
  }

  // ---- Shared code ---------------------------------------------------------
  const allowedDifferences: string[] = [];
  if (facts.divergentPaths === null || masterRev === null) {
    results.push({
      area: "Shared code",
      name: "shared code is identical to the master revision",
      severity: "required",
      ok: false,
      detail:
        "could not be compared — there is no merged master revision to compare against (fix the Master revision failures above and re-run)",
    });
  } else {
    const { allowed, findings } = splitDivergentPaths(facts.divergentPaths);
    allowedDifferences.push(...allowed);
    results.push({
      area: "Shared code",
      name: `every tracked file matches master ${masterRev}`,
      severity: "required",
      ok: findings.length === 0,
      detail:
        findings.length === 0
          ? allowed.length > 0
            ? `only the customer's own ${allowed.join(", ")} differs, as expected`
            : undefined
          : `${findings.length} file(s) differ from master — this fork carries local code, which is what makes the next update conflict`,
      items: findings.length > 0 ? findings : undefined,
    });
  }

  // ---- Merge conflicts -----------------------------------------------------
  results.push({
    area: "Merge conflicts",
    name: "no leftover conflict markers in tracked files",
    severity: "required",
    ok: facts.conflicts.length === 0,
    detail:
      facts.conflicts.length === 0
        ? undefined
        : `${facts.conflicts.length} marker line(s) left behind by an unfinished merge`,
    items:
      facts.conflicts.length > 0
        ? facts.conflicts.map((c) => `${c.path}:${c.line}  ${c.marker}`)
        : undefined,
  });

  // ---- Tenant environment --------------------------------------------------
  const orgCode = facts.env.orgCode;
  results.push({
    area: "Tenant environment",
    name: "ORG_CODE is set",
    severity: "required",
    ok: orgCode !== null,
    detail: orgCode === null ? "no ORG_CODE in this fork's environment" : undefined,
  });
  if (orgCode !== null) {
    const isMaster = orgCode.value.trim().toLowerCase() === MASTER_ORG_CODE;
    results.push({
      area: "Tenant environment",
      name: "ORG_CODE is the customer's own, not the master template's",
      severity: "required",
      ok: !isMaster,
      detail: isMaster
        ? `still the master template's org code "${MASTER_ORG_CODE}" (${describeSource(orgCode.source)}) — the customer's env blocks were lost in the merge`
        : `"${orgCode.value}" (${describeSource(orgCode.source)})`,
    });
  }
  for (const name of FORBIDDEN_ENV_VARS) {
    const found = facts.env.forbidden[name];
    results.push({
      area: "Tenant environment",
      name: `${name} is absent`,
      severity: "required",
      ok: !found,
      detail: found
        ? `${describeSource(found.source)} — ${
            name === "EXPO_TOKEN"
              ? "a fork holding this could push phone-app updates to every other customer"
              : "the org directory belongs to the master template only"
          }`
        : undefined,
    });
  }

  // ---- Pre-publish data ----------------------------------------------------
  // Only evaluated when the database was actually consulted; the CLI always
  // consults it, so a real run always reports this area.
  if (facts.uniqueData) {
    results.push(...evaluateUniqueData(facts.uniqueData));
  }

  return { results, allowedDifferences, masterRev };
}

function describeSource(source: EnvSource): string {
  return source === "replit" ? ".replit [userenv*]" : "process env";
}

export interface Summary {
  total: number;
  passed: number;
  failedRequired: CheckResult[];
  failedRecommended: CheckResult[];
  exitCode: 0 | 1;
}

/** Roll the checks up into a pass/fail verdict and the process exit code. */
export function summarize(results: CheckResult[]): Summary {
  const failedRequired = results.filter((r) => !r.ok && r.severity === "required");
  const failedRecommended = results.filter((r) => !r.ok && r.severity === "recommended");
  return {
    total: results.length,
    passed: results.length - failedRequired.length - failedRecommended.length,
    failedRequired,
    failedRecommended,
    exitCode: failedRequired.length > 0 ? 1 : 0,
  };
}

/**
 * Parse the `[userenv]` / `[userenv.shared]` / `[userenv.production]` tables out
 * of a `.replit` file. Only those tables are read: they are the customer's own
 * environment, the one part of the file that must survive an update.
 */
export function parseReplitUserEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  let inUserEnv = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      const table = line.replace(/^\[+/, "").replace(/\]+$/, "").trim();
      inUserEnv = table === "userenv" || table.startsWith("userenv.");
      continue;
    }
    if (!inUserEnv || line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * Resolve one env var from the fork's two sources. `.replit` is reported first
 * because that is the file the operator edits during the merge, but a value
 * injected only into the shell/deployment env counts as present too.
 */
export function lookupEnvValue(
  name: string,
  replitEnv: Record<string, string>,
  procEnv: Record<string, string | undefined>,
): EnvValue | null {
  const fromReplit = replitEnv[name]?.trim();
  if (fromReplit) return { value: fromReplit, source: "replit" };
  const fromProcess = procEnv[name]?.trim();
  if (fromProcess) return { value: fromProcess, source: "process" };
  return null;
}

/** Build the environment facts from the two sources. */
export function collectEnvFacts(
  replitEnv: Record<string, string>,
  procEnv: Record<string, string | undefined>,
): ForkEnv {
  const forbidden: Record<string, EnvValue> = {};
  for (const name of FORBIDDEN_ENV_VARS) {
    const found = lookupEnvValue(name, replitEnv, procEnv);
    if (found) forbidden[name] = found;
  }
  return { orgCode: lookupEnvValue("ORG_CODE", replitEnv, procEnv), forbidden };
}

// ---------------------------------------------------------------------------
// Collection (I/O)
// ---------------------------------------------------------------------------

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  })
    .toString()
    .trim();
}

function tryGit(repoRoot: string, args: string[]): string | null {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

export function readUpstreamState(repoRoot: string): UpstreamState {
  const rev = tryGit(repoRoot, ["rev-parse", "--short", UPSTREAM_REF]);
  if (!rev) return { refPresent: false, rev: null, mergedIntoHead: false };
  const merged =
    tryGit(repoRoot, ["merge-base", "--is-ancestor", UPSTREAM_REF, "HEAD"]) !== null;
  return { refPresent: true, rev, mergedIntoHead: merged };
}

/**
 * Every tracked path whose content differs from `rev` — committed drift AND
 * uncommitted local edits, since both break the "exact copy of master" rule.
 */
export function readDivergentPaths(repoRoot: string, rev: string): string[] | null {
  const out = tryGit(repoRoot, ["diff", "--name-only", rev, "--"]);
  if (out === null) return null;
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

/**
 * Build the conflict-marker patterns at runtime so this file (and its tests)
 * never contain a literal marker that the check would then flag in the repo it
 * is scanning.
 */
function conflictMarkerPattern(): string {
  const open = "<".repeat(7);
  const mid = "=".repeat(7);
  const close = ">".repeat(7);
  return `^(${open}( |$)|${mid}$|${close}( |$))`;
}

/** Scan tracked text files (`git grep -I`) for leftover conflict markers. */
export function scanConflictMarkers(repoRoot: string): ConflictHit[] {
  const res = spawnSync(
    "git",
    ["grep", "-I", "-n", "-E", conflictMarkerPattern(), "--", "."],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  // git grep: 0 = matches found, 1 = no matches, >1 = real error.
  if (res.status === 1) return [];
  if (res.status !== 0) {
    throw new Error(
      `git grep failed (exit ${res.status}): ${(res.stderr || "").toString().trim()}`,
    );
  }
  return parseConflictGrep(res.stdout ?? "");
}

/** Parse `git grep -n` output (`path:line:text`) into conflict hits. */
export function parseConflictGrep(stdout: string): ConflictHit[] {
  const hits: ConflictHit[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const filePath = line.slice(0, first);
    const lineNo = Number(line.slice(first + 1, second));
    const text = line.slice(second + 1);
    hits.push({
      path: filePath,
      line: Number.isFinite(lineNo) ? lineNo : 0,
      marker: text.trim().slice(0, 7),
    });
  }
  return hits;
}

/**
 * Read the uniqueness preconditions from whichever database this repl points
 * at. `OVERRIDE_DATABASE_URL` wins so an operator can aim the same command at
 * the tenant's PRODUCTION database without touching their dev environment;
 * every statement issued is a read-only SELECT.
 */
export async function collectUniqueDataFacts(
  procEnv: Record<string, string | undefined> = process.env,
): Promise<UniqueDataFacts> {
  const override = procEnv.OVERRIDE_DATABASE_URL?.trim();
  const source = override ? "OVERRIDE_DATABASE_URL" : "DATABASE_URL";
  const connectionString = override || procEnv.DATABASE_URL?.trim();
  if (!connectionString) {
    return {
      source,
      error:
        "neither OVERRIDE_DATABASE_URL nor DATABASE_URL is set, so the data " +
        "this publish would migrate could not be checked",
      preconditions: [],
    };
  }

  const rules = collectUniqueRulesFrom(schema as Record<string, unknown>);
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const existingTables = await loadExistingTables(client);
    const preconditions = await checkUniquePreconditions(
      client,
      rules,
      existingTables,
    );
    return { source, error: null, preconditions };
  } catch (err) {
    return {
      source,
      error: `could not read the database: ${(err as Error).message}`,
      preconditions: [],
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export function collectForkFacts(repoRoot: string): ForkFacts {
  const upstream = readUpstreamState(repoRoot);
  const masterRev = resolveMasterRev(upstream);
  const replitPath = path.join(repoRoot, ".replit");
  const replitEnv = existsSync(replitPath)
    ? parseReplitUserEnv(readFileSync(replitPath, "utf8"))
    : {};
  return {
    upstream,
    divergentPaths: masterRev ? readDivergentPaths(repoRoot, masterRev) : null,
    conflicts: scanConflictMarkers(repoRoot),
    env: collectEnvFacts(replitEnv, process.env),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function statusTag(ok: boolean, severity: Severity): string {
  if (ok) return "OK  ";
  return severity === "required" ? "FAIL" : "WARN";
}

export function printVerdict(verdict: ForkVerdict): Summary {
  let area = "";
  for (const r of verdict.results) {
    if (r.area !== area) {
      area = r.area;
      console.log(`\n${area}`);
    }
    console.log(`  [${statusTag(r.ok, r.severity)}] ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
    for (const item of r.items ?? []) {
      console.log(`         • ${item}`);
    }
  }

  const summary = summarize(verdict.results);
  console.log(
    `\n${summary.passed}/${summary.total} checks passed` +
      (summary.failedRecommended.length
        ? `, ${summary.failedRecommended.length} recommended gap(s)`
        : "") +
      (summary.failedRequired.length
        ? `, ${summary.failedRequired.length} REQUIRED gap(s)`
        : "") +
      ".",
  );

  // The data failure has its own remediation — it is not a code-drift problem
  // and the "take master's version wholesale" advice would not fix it.
  const dataFailed = summary.failedRequired.some(
    (r) => r.area === "Pre-publish data",
  );
  if (dataFailed) {
    console.log(`\n${UNIQUE_VIOLATION_ADVICE}`);
  }

  const codeFailed = summary.failedRequired.some(
    (r) => r.area !== "Pre-publish data",
  );
  if (codeFailed) {
    console.log(
      "\nThis fork is NOT a verified copy of the master revision — do NOT republish it.\n" +
        "A customer fork is read-only downstream code: no agent tasks, no local edits.\n" +
        "Shared-code differences or conflict markers mean the fork has drifted; follow\n" +
        '"Recovering a fork that has already drifted" in\n' +
        "docs/update-existing-customer-runbook.md — take master's version of shared code\n" +
        "wholesale and keep only the customer's .replit env blocks by hand.",
    );
  } else if (summary.exitCode === 1) {
    console.log(
      "\nThis fork's CODE is a verified copy of master, but its DATA is not safe to\n" +
        "publish yet — do NOT republish until the failure above is cleared.",
    );
  } else {
    console.log(
      `\nThis fork's shared code is an exact copy of master ${verdict.masterRev}` +
        (verdict.allowedDifferences.length
          ? ` (only ${verdict.allowedDifferences.join(", ")} differs, as expected)`
          : "") +
        ".",
    );
  }
  return summary;
}

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../..");
}

export async function main(): Promise<void> {
  const repoRoot = repoRootFromHere();
  console.log(`Fork-integrity check — ${repoRoot}`);
  const facts = collectForkFacts(repoRoot);
  facts.uniqueData = await collectUniqueDataFacts();
  const verdict = evaluateFork(facts);
  const summary = printVerdict(verdict);
  if (summary.exitCode !== 0) process.exit(summary.exitCode);
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
  main().catch((err: unknown) => {
    console.error("[check-fork-integrity] crashed:", err);
    process.exit(1);
  });
}
