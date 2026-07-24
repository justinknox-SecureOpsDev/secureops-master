/**
 * OTA-COMPAT GUARD TEST — catches the exact class of crash that broke radio
 * on App Store builds ≤ 9.
 *
 * Some native packages exist only in NEWER binaries of the current runtime
 * (the list lives in components/radio/nativeModules.ts →
 * BINARY_GATED_NATIVE_PACKAGES, documented in RADIO_NATIVE_RELEASE_RUNBOOK.md).
 * Because runtimeVersion policy is `appVersion`, an OTA bundle is served to
 * EVERY binary of that runtime — so a static value import of one of those
 * packages evaluates on app launch/screen load and hard-crashes any install
 * whose native image lacks the module.
 *
 * This test scans all bundled app source and fails if a gated package is:
 *   - statically value-imported (`import { X } from "pkg"`), or
 *   - value re-exported (`export { X } from "pkg"`), or
 *   - `require()`d / dynamically `import()`ed outside its approved guarded
 *     loader file.
 *
 * Type-only usage (`import type`, `export type`, `typeof import("pkg")`) is
 * always fine — it is erased at compile time.
 *
 * If this test fails: load the package through a guarded lazy loader (see
 * getLiveKitNative() in components/radio/nativeModules.ts or getExpoAudio()
 * in components/radio/radioMedia.native.ts) and degrade gracefully, or bump
 * the runtime version so old binaries never receive the bundle.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BINARY_GATED_NATIVE_PACKAGES } from "../components/radio/nativeModules";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directories whose contents end up in the OTA JS bundle. */
const BUNDLED_DIRS = [
  "app",
  "components",
  "constants",
  "contexts",
  "hooks",
  "utils",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function isSourceFile(filePath: string): boolean {
  if (!SOURCE_EXTENSIONS.has(path.extname(filePath))) return false;
  if (filePath.endsWith(".d.ts")) return false;
  const rel = path.relative(APP_ROOT, filePath);
  if (rel.split(path.sep).includes("__tests__")) return false;
  if (/\.test\.[tj]sx?$/.test(rel)) return false;
  return true;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      walk(full, out);
    } else if (entry.isFile() && isSourceFile(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Blank out comments while preserving line numbers and string contents. */
function stripComments(source: string): string {
  // Block comments → keep only the newlines so offsets stay line-accurate.
  let stripped = source.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  // Line comments — the [^:"'`] guard avoids eating "https://…" inside strings.
  stripped = stripped.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, p1: string) => p1);
  return stripped;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Violation {
  file: string;
  line: number;
  pkg: string;
  kind: string;
  snippet: string;
}

function scanFile(filePath: string): Violation[] {
  const rel = path.relative(APP_ROOT, filePath).split(path.sep).join("/");
  const source = stripComments(readFileSync(filePath, "utf8"));
  const violations: Violation[] = [];

  for (const gated of BINARY_GATED_NATIVE_PACKAGES) {
    const pkg = escapeRegExp(gated.package);
    // Matches "pkg" and any subpath "pkg/…" in quotes.
    const spec = `["'](?:${pkg})(?:\\/[^"']*)?["']`;
    const isAllowedLoader = gated.allowedLoaderFiles.includes(rel);

    // Static import … from "pkg" — allowed only when type-only.
    for (const m of source.matchAll(
      new RegExp(`(?:^|[\\n;])\\s*(import\\s[^;]*?from\\s*${spec})`, "g"),
    )) {
      const stmt = m[1];
      if (/^import\s+type\b/.test(stmt)) continue;
      violations.push({
        file: rel,
        line: lineOf(source, m.index + m[0].indexOf(stmt)),
        pkg: gated.package,
        kind: "static value import",
        snippet: stmt.replace(/\s+/g, " ").slice(0, 120),
      });
    }

    // export … from "pkg" — allowed only when type-only.
    for (const m of source.matchAll(
      new RegExp(`(?:^|[\\n;])\\s*(export\\s[^;]*?from\\s*${spec})`, "g"),
    )) {
      const stmt = m[1];
      if (/^export\s+type\b/.test(stmt)) continue;
      violations.push({
        file: rel,
        line: lineOf(source, m.index + m[0].indexOf(stmt)),
        pkg: gated.package,
        kind: "value re-export",
        snippet: stmt.replace(/\s+/g, " ").slice(0, 120),
      });
    }

    // Bare side-effect import: import "pkg";
    for (const m of source.matchAll(
      new RegExp(`(?:^|[\\n;])\\s*(import\\s*${spec})`, "g"),
    )) {
      violations.push({
        file: rel,
        line: lineOf(source, m.index + m[0].indexOf(m[1])),
        pkg: gated.package,
        kind: "side-effect import",
        snippet: m[1].replace(/\s+/g, " ").slice(0, 120),
      });
    }

    // require("pkg") / import("pkg") — only allowed inside the guarded
    // loader file. `typeof import("pkg")` is type-only and always fine.
    if (!isAllowedLoader) {
      for (const m of source.matchAll(
        new RegExp(`(?<!typeof\\s{0,10})(require|import)\\(\\s*${spec}\\s*\\)`, "g"),
      )) {
        violations.push({
          file: rel,
          line: lineOf(source, m.index),
          pkg: gated.package,
          kind: `${m[1]}() outside approved loader`,
          snippet: m[0].replace(/\s+/g, " ").slice(0, 120),
        });
      }
    }
  }
  return violations;
}

describe("binary-gated native packages are never statically imported", () => {
  const files = BUNDLED_DIRS.flatMap((dir) => {
    const full = path.join(APP_ROOT, dir);
    try {
      return walk(full, []);
    } catch {
      return [];
    }
  });

  it("scans a sane number of bundled source files", () => {
    // Guards against the walker silently scanning nothing (e.g. after a
    // directory rename) and the whole suite green-lighting by accident.
    expect(files.length).toBeGreaterThan(50);
  });

  it("finds no unguarded imports of binary-gated native packages", () => {
    const violations = files.flatMap(scanFile);
    const report = violations
      .map((v) => `${v.file}:${v.line} — ${v.kind} of "${v.pkg}": ${v.snippet}`)
      .join("\n");
    expect(violations, `\n${report}\n\nSee RADIO_NATIVE_RELEASE_RUNBOOK.md — load these packages through their guarded lazy loader instead.`).toEqual([]);
  });

  it("each approved loader file exists and actually references its package", () => {
    for (const gated of BINARY_GATED_NATIVE_PACKAGES) {
      for (const loader of gated.allowedLoaderFiles) {
        const full = path.join(APP_ROOT, loader);
        const content = readFileSync(full, "utf8");
        expect(
          content.includes(`"${gated.package}"`),
          `${loader} should reference ${gated.package}`,
        ).toBe(true);
      }
    }
  });
});
