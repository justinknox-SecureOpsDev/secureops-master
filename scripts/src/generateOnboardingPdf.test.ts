/**
 * Flag/path handling for the client setup-checklist PDF generator. The
 * failure that matters here is a silent one: a mistyped flag falling back to
 * the shared template path and overwriting it with one customer's copy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFlag, resolvePaths } from "./generate-onboarding-pdf.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

describe("readFlag", () => {
  it("reads a flag's value", () => {
    expect(readFlag(["--in", "docs/a.md"], "--in")).toBe("docs/a.md");
  });

  it("returns undefined when the flag is absent", () => {
    expect(readFlag(["--out", "x.pdf"], "--in")).toBeUndefined();
  });

  it("throws when the flag has no value", () => {
    expect(() => readFlag(["--in"], "--in")).toThrow(/Missing value for --in/);
  });

  it("throws rather than swallowing the next flag as a value", () => {
    expect(() => readFlag(["--in", "--out", "x.pdf"], "--in")).toThrow(/Missing value for --in/);
  });
});

describe("resolvePaths", () => {
  it("defaults to the shared template and its PDF", () => {
    const { input, output, title } = resolvePaths([]);
    expect(input).toBe(path.resolve(repoRoot, "docs/client-system-setup-checklist.md"));
    expect(output).toBe(path.resolve(repoRoot, "docs/client-system-setup-checklist.pdf"));
    expect(title).toContain("SecureOps Command");
  });

  it("resolves overrides against the repo root, not the cwd", () => {
    const { input, output, title } = resolvePaths([
      "--in",
      "docs/customers/acme.md",
      "--out",
      "docs/customers/acme.pdf",
      "--title",
      "Acme Security",
    ]);
    expect(input).toBe(path.resolve(repoRoot, "docs/customers/acme.md"));
    expect(output).toBe(path.resolve(repoRoot, "docs/customers/acme.pdf"));
    expect(title).toBe("Acme Security");
  });
});

describe("checklist source", () => {
  it("stays inside the WinAnsi range pdfkit's built-in fonts can render", () => {
    const md = readFileSync(path.resolve(repoRoot, "docs/client-system-setup-checklist.md"), "utf8");
    // Symbols such as U+2610 BALLOT BOX silently render as "&" in the PDF.
    const unsupported = [...new Set(md.match(/[^\u0000-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D]/g) ?? [])];
    expect(unsupported).toEqual([]);
  });

  it("never asks a customer to email a password", () => {
    const md = readFileSync(path.resolve(repoRoot, "docs/client-system-setup-checklist.md"), "utf8");
    expect(md).toMatch(/never send a password by email/i);
  });
});
