/**
 * Staleness guard: the embedded legal templates in
 * lib/legal-docs/src/templates.generated.ts must match the markdown sources
 * of truth in legal/*.md. If this fails, run:
 *   pnpm --filter @workspace/scripts run generate-legal-pdfs
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  AGREEMENT_SLOTS,
  AGREEMENT_FILE_BASES,
  LEGAL_TEMPLATES,
  fillAgreement,
  AGREEMENT_FIELDS,
} from "@workspace/legal-docs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

describe("legal document templates", () => {
  for (const slot of AGREEMENT_SLOTS) {
    it(`embedded ${slot} template matches legal/${AGREEMENT_FILE_BASES[slot]}.md`, () => {
      const src = readFileSync(
        path.resolve(repoRoot, "legal", `${AGREEMENT_FILE_BASES[slot]}.md`),
        "utf8",
      );
      expect(LEGAL_TEMPLATES[slot]).toBe(src);
    });

    it(`template PDFs exist in both locations for ${slot}`, () => {
      for (const dir of ["legal", path.join("artifacts", "admin-portal", "public", "legal")]) {
        expect(
          existsSync(path.resolve(repoRoot, dir, `${AGREEMENT_FILE_BASES[slot]}.pdf`)),
          `${dir}/${AGREEMENT_FILE_BASES[slot]}.pdf missing`,
        ).toBe(true);
      }
    });

    it(`every allow-listed token for ${slot} appears in the template`, () => {
      for (const def of AGREEMENT_FIELDS[slot]) {
        expect(LEGAL_TEMPLATES[slot], `token ${def.token} not found`).toContain(def.token);
      }
    });
  }

  it("fills every token when all fields are provided (msa, no guaranty)", () => {
    const values: Record<string, string> = {};
    for (const def of AGREEMENT_FIELDS.msa) {
      if (def.group !== "guaranty") values[def.key] = def.defaultValue ?? "Test Value";
    }
    const result = fillAgreement("msa", values);
    expect(result.missing).toEqual([]);
    expect(result.leftoverTokens).toEqual([]);
    expect(result.guarantyExecuted).toBe(false);
    expect(result.markdown).toContain("Exhibit C was not executed");
    // The banner's literal [ALL-CAPS] mention must survive filling untouched.
    expect(result.markdown).toContain("[ALL-CAPS]");
  });

  it("markdown metacharacters in values are escaped", () => {
    const values: Record<string, string> = {};
    for (const def of AGREEMENT_FIELDS.user_agreement) {
      values[def.key] = def.defaultValue ?? "Test Value";
    }
    values.arbitrationCity = "# Houston *";
    const result = fillAgreement("user_agreement", values);
    expect(result.missing).toEqual([]);
    expect(result.markdown).toContain("\\# Houston \\*");
  });
});
