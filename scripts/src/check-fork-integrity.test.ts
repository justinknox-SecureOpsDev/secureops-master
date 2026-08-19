/**
 * Verdict-logic unit tests for the fork-integrity check
 * (`check-fork-integrity.ts`).
 *
 * These exercise the decision logic against synthetic facts — no git, no repl,
 * no environment — covering the five states an operator can actually be in:
 *   1. a matching tree (the fork is an exact copy of master),
 *   2. a diverged shared file (the fork carries local code),
 *   3. an upstream ref fetched but never merged,
 *   4. leftover merge-conflict markers,
 *   5. forbidden environment values (master's org code, the org directory, an
 *      Expo token).
 *
 * The module guards its CLI entry point behind `isMainModule()`, so importing
 * it here does not run the check or call `process.exit`.
 */
import { describe, it, expect } from "vitest";
import {
  MASTER_ORG_CODE,
  UPSTREAM_REF,
  collectEnvFacts,
  evaluateFork,
  isAllowedDivergentPath,
  lookupEnvValue,
  parseConflictGrep,
  parseReplitUserEnv,
  resolveMasterRev,
  splitDivergentPaths,
  summarize,
  type CheckResult,
  type ForkEnv,
  type ForkFacts,
} from "./check-fork-integrity.js";

/** A healthy tenant environment: own org code, no directory, no Expo token. */
const cleanEnv: ForkEnv = {
  orgCode: { value: "quell", source: "replit" },
  forbidden: {},
};

/** Facts for a fork that is an exact copy of master, env file aside. */
function cleanFacts(overrides: Partial<ForkFacts> = {}): ForkFacts {
  return {
    upstream: { refPresent: true, rev: "abc1234", mergedIntoHead: true },
    divergentPaths: [".replit"],
    conflicts: [],
    env: cleanEnv,
    ...overrides,
  };
}

function failedNames(results: CheckResult[]): string[] {
  return results.filter((r) => !r.ok).map((r) => r.name);
}

function find(results: CheckResult[], namePart: string): CheckResult {
  const hit = results.find((r) => r.name.includes(namePart));
  if (!hit) throw new Error(`no check matching "${namePart}"`);
  return hit;
}

describe("resolveMasterRev", () => {
  it("uses the fetched upstream ref once it is an ancestor of HEAD", () => {
    expect(
      resolveMasterRev({ refPresent: true, rev: "abc1234", mergedIntoHead: true }),
    ).toBe("abc1234");
  });

  it("refuses a fetched-but-unmerged ref (same rule as the build identity)", () => {
    expect(
      resolveMasterRev({ refPresent: true, rev: "abc1234", mergedIntoHead: false }),
    ).toBeNull();
  });

  it("is null when the fork has never fetched the master", () => {
    expect(
      resolveMasterRev({ refPresent: false, rev: null, mergedIntoHead: false }),
    ).toBeNull();
  });
});

describe("splitDivergentPaths", () => {
  it("treats the customer's env file as the one allowed difference", () => {
    expect(isAllowedDivergentPath(".replit")).toBe(true);
    const { allowed, findings } = splitDivergentPaths([".replit"]);
    expect(allowed).toEqual([".replit"]);
    expect(findings).toEqual([]);
  });

  it("treats every other differing path as a finding", () => {
    const { allowed, findings } = splitDivergentPaths([
      ".replit",
      "artifacts/api-server/src/routes/admin.ts",
      "docs/update-existing-customer-runbook.md",
    ]);
    expect(allowed).toEqual([".replit"]);
    expect(findings).toEqual([
      "artifacts/api-server/src/routes/admin.ts",
      "docs/update-existing-customer-runbook.md",
    ]);
  });

  it("does not treat a lookalike path as the env file", () => {
    expect(isAllowedDivergentPath("packages/.replit")).toBe(false);
    expect(isAllowedDivergentPath(".replit.bak")).toBe(false);
  });
});

describe("evaluateFork — a matching tree", () => {
  const verdict = evaluateFork(cleanFacts());

  it("passes every required check", () => {
    expect(failedNames(verdict.results)).toEqual([]);
    expect(summarize(verdict.results).exitCode).toBe(0);
  });

  it("reports the master revision it verified against", () => {
    expect(verdict.masterRev).toBe("abc1234");
    expect(find(verdict.results, "matches master").name).toContain("abc1234");
  });

  it("records the env file as an expected, allowed difference", () => {
    expect(verdict.allowedDifferences).toEqual([".replit"]);
  });

  it("still passes when even the env file is identical", () => {
    const v = evaluateFork(cleanFacts({ divergentPaths: [] }));
    expect(summarize(v.results).exitCode).toBe(0);
    expect(v.allowedDifferences).toEqual([]);
  });
});

describe("evaluateFork — a diverged shared file", () => {
  const verdict = evaluateFork(
    cleanFacts({
      divergentPaths: [
        ".replit",
        "artifacts/api-server/src/routes/admin.ts",
        "artifacts/api-server/src/routes/payroll.ts",
      ],
    }),
  );

  it("fails the shared-code check", () => {
    const check = find(verdict.results, "matches master");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("required");
    expect(summarize(verdict.results).exitCode).toBe(1);
  });

  it("lists every differing file by path, and only the real findings", () => {
    expect(find(verdict.results, "matches master").items).toEqual([
      "artifacts/api-server/src/routes/admin.ts",
      "artifacts/api-server/src/routes/payroll.ts",
    ]);
  });

  it("leaves the other areas passing (findings are not cross-contaminated)", () => {
    expect(failedNames(verdict.results)).toEqual([
      "every tracked file matches master abc1234",
    ]);
  });
});

describe("evaluateFork — upstream fetched but not merged", () => {
  const verdict = evaluateFork(
    cleanFacts({
      upstream: { refPresent: true, rev: "abc1234", mergedIntoHead: false },
      divergentPaths: null,
    }),
  );

  it("fails the merged-into-HEAD check", () => {
    const check = find(verdict.results, "merged into HEAD");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("abc1234");
  });

  it("refuses to claim a master revision", () => {
    expect(verdict.masterRev).toBeNull();
  });

  it("reports shared code as not comparable rather than as passing", () => {
    const check = find(verdict.results, "shared code is identical");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("could not be compared");
    expect(summarize(verdict.results).exitCode).toBe(1);
  });

  it("still evaluates the remaining areas in the same run", () => {
    expect(find(verdict.results, "conflict markers").ok).toBe(true);
    expect(find(verdict.results, "ORG_CODE is set").ok).toBe(true);
  });
});

describe("evaluateFork — never fetched at all", () => {
  const verdict = evaluateFork(
    cleanFacts({
      upstream: { refPresent: false, rev: null, mergedIntoHead: false },
      divergentPaths: null,
    }),
  );

  it("fails on the missing upstream ref and skips the ancestry check", () => {
    expect(find(verdict.results, "fetched as upstream/main").ok).toBe(false);
    expect(
      verdict.results.some((r) => r.name.includes("merged into HEAD")),
    ).toBe(false);
    expect(summarize(verdict.results).exitCode).toBe(1);
  });
});

describe("evaluateFork — leftover conflict markers", () => {
  // Built at runtime so this test file never contains a literal marker that the
  // check would then flag when scanning the repo.
  const open = "<".repeat(7);
  const close = ">".repeat(7);
  const verdict = evaluateFork(
    cleanFacts({
      conflicts: [
        { path: "artifacts/api-server/src/routes/admin.ts", line: 120, marker: open },
        { path: "artifacts/api-server/src/routes/admin.ts", line: 148, marker: close },
      ],
    }),
  );

  it("fails the conflict-marker check", () => {
    const check = find(verdict.results, "conflict markers");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("required");
    expect(summarize(verdict.results).exitCode).toBe(1);
  });

  it("lists each marker with its path and line", () => {
    expect(find(verdict.results, "conflict markers").items).toEqual([
      `artifacts/api-server/src/routes/admin.ts:120  ${open}`,
      `artifacts/api-server/src/routes/admin.ts:148  ${close}`,
    ]);
  });
});

describe("evaluateFork — forbidden environment values", () => {
  const verdict = evaluateFork(
    cleanFacts({
      env: {
        orgCode: { value: MASTER_ORG_CODE, source: "replit" },
        forbidden: {
          ORG_DIRECTORY: { value: "[{...}]", source: "replit" },
          EXPO_TOKEN: { value: "tok", source: "process" },
        },
      },
    }),
  );

  it("fails when the fork still carries the master template's org code", () => {
    const check = find(verdict.results, "customer's own");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(MASTER_ORG_CODE);
  });

  it("fails on the org directory and the Expo token", () => {
    expect(find(verdict.results, "ORG_DIRECTORY is absent").ok).toBe(false);
    expect(find(verdict.results, "EXPO_TOKEN is absent").ok).toBe(false);
    expect(find(verdict.results, "EXPO_TOKEN is absent").detail).toContain(
      "every other customer",
    );
  });

  it("reports all three at once and exits non-zero", () => {
    expect(failedNames(verdict.results)).toEqual([
      "ORG_CODE is the customer's own, not the master template's",
      "ORG_DIRECTORY is absent",
      "EXPO_TOKEN is absent",
    ]);
    expect(summarize(verdict.results).exitCode).toBe(1);
  });

  it("is case-insensitive about the master org code", () => {
    const v = evaluateFork(
      cleanFacts({
        env: { orgCode: { value: "WCSGI", source: "process" }, forbidden: {} },
      }),
    );
    expect(find(v.results, "customer's own").ok).toBe(false);
  });

  it("fails when ORG_CODE is missing entirely", () => {
    const v = evaluateFork(cleanFacts({ env: { orgCode: null, forbidden: {} } }));
    expect(find(v.results, "ORG_CODE is set").ok).toBe(false);
    expect(v.results.some((r) => r.name.includes("customer's own"))).toBe(false);
  });
});

describe("evaluateFork — everything wrong at once", () => {
  it("reports every area in one run instead of stopping at the first", () => {
    const verdict = evaluateFork({
      upstream: { refPresent: true, rev: "abc1234", mergedIntoHead: true },
      divergentPaths: ["artifacts/api-server/src/routes/admin.ts"],
      conflicts: [
        { path: "artifacts/api-server/src/routes/payroll.ts", line: 9, marker: "=".repeat(7) },
      ],
      env: {
        orgCode: { value: MASTER_ORG_CODE, source: "replit" },
        forbidden: { EXPO_TOKEN: { value: "tok", source: "replit" } },
      },
    });
    const areas = new Set(verdict.results.filter((r) => !r.ok).map((r) => r.area));
    expect([...areas].sort()).toEqual([
      "Merge conflicts",
      "Shared code",
      "Tenant environment",
    ]);
    expect(summarize(verdict.results).exitCode).toBe(1);
  });
});

describe("summarize", () => {
  const base: CheckResult = { area: "A", name: "n", severity: "required", ok: true };

  it("counts passes and exits 0 when nothing required failed", () => {
    const s = summarize([base, { ...base, name: "m" }]);
    expect(s.passed).toBe(2);
    expect(s.exitCode).toBe(0);
  });

  it("exits 1 on any required failure", () => {
    const s = summarize([base, { ...base, name: "bad", ok: false }]);
    expect(s.failedRequired).toHaveLength(1);
    expect(s.exitCode).toBe(1);
  });

  it("warns but does not fail on a recommended gap", () => {
    const s = summarize([
      base,
      { ...base, name: "soft", severity: "recommended", ok: false },
    ]);
    expect(s.failedRecommended).toHaveLength(1);
    expect(s.passed).toBe(1);
    expect(s.exitCode).toBe(0);
  });
});

describe("parseReplitUserEnv", () => {
  const replit = [
    'modules = ["nodejs-24"]',
    "",
    "[deployment]",
    'deploymentTarget = "vm"',
    "",
    "[userenv]",
    "",
    "[userenv.production]",
    'APP_BASE_URL = "https://quellsecurity.com"',
    "",
    "[userenv.shared]",
    "# a comment",
    'ORG_CODE = "quell"',
    'SUPER_ADMIN_EMAILS = "ops@quell.example"',
    "",
    "[objectStorage]",
    'defaultBucketID = "replit-objstore-xyz"',
  ].join("\n");

  it("reads keys from every userenv table", () => {
    const env = parseReplitUserEnv(replit);
    expect(env.ORG_CODE).toBe("quell");
    expect(env.APP_BASE_URL).toBe("https://quellsecurity.com");
  });

  it("ignores keys outside the userenv tables", () => {
    const env = parseReplitUserEnv(replit);
    expect(env.deploymentTarget).toBeUndefined();
    expect(env.defaultBucketID).toBeUndefined();
  });

  it("unescapes quoted values (the ORG_DIRECTORY JSON blob)", () => {
    const env = parseReplitUserEnv(
      ['[userenv.shared]', 'ORG_DIRECTORY = "[{\\"code\\":\\"wcsgi\\"}]"'].join("\n"),
    );
    expect(env.ORG_DIRECTORY).toBe('[{"code":"wcsgi"}]');
  });
});

describe("lookupEnvValue / collectEnvFacts", () => {
  it("prefers the .replit value and labels its source", () => {
    expect(lookupEnvValue("ORG_CODE", { ORG_CODE: "quell" }, { ORG_CODE: "other" })).toEqual({
      value: "quell",
      source: "replit",
    });
  });

  it("falls back to the process environment", () => {
    expect(lookupEnvValue("EXPO_TOKEN", {}, { EXPO_TOKEN: "tok" })).toEqual({
      value: "tok",
      source: "process",
    });
  });

  it("treats blank values as absent", () => {
    expect(lookupEnvValue("ORG_CODE", { ORG_CODE: "   " }, { ORG_CODE: "" })).toBeNull();
  });

  it("collects only the forbidden vars that are actually present", () => {
    const facts = collectEnvFacts({ ORG_CODE: "quell" }, { EXPO_TOKEN: "tok" });
    expect(facts.orgCode).toEqual({ value: "quell", source: "replit" });
    expect(Object.keys(facts.forbidden)).toEqual(["EXPO_TOKEN"]);
  });

  it("finds a clean fork's environment to be clean", () => {
    const facts = collectEnvFacts({ ORG_CODE: "quell" }, {});
    expect(facts.forbidden).toEqual({});
    expect(evaluateFork(cleanFacts({ env: facts }))).toMatchObject({
      masterRev: "abc1234",
    });
  });
});

describe("parseConflictGrep", () => {
  it("parses path, line, and marker out of git grep -n output", () => {
    const open = "<".repeat(7);
    const hits = parseConflictGrep(`src/a.ts:12:${open} HEAD\nsrc/a.ts:20:${"=".repeat(7)}\n`);
    expect(hits).toEqual([
      { path: "src/a.ts", line: 12, marker: open },
      { path: "src/a.ts", line: 20, marker: "=".repeat(7) },
    ]);
  });

  it("returns nothing for empty output (no matches)", () => {
    expect(parseConflictGrep("")).toEqual([]);
  });
});

describe("constants", () => {
  it("pins the upstream ref the runbook tells operators to fetch", () => {
    expect(UPSTREAM_REF).toBe("refs/remotes/upstream/main");
  });

  it("pins the master template's own org code", () => {
    expect(MASTER_ORG_CODE).toBe("wcsgi");
  });
});
