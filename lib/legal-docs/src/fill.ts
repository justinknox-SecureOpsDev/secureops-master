import {
  AGREEMENT_FIELDS,
  type AgreementFieldDef,
  type AgreementSlot,
} from "./fields";
import { LEGAL_TEMPLATES } from "./templates.generated";

/**
 * Escape markdown metacharacters in a user-supplied fill value so it is
 * rendered as plain text and cannot restructure the legal document (e.g. a
 * value of "# Terminated" must not become a heading). CommonMark unescapes
 * backslash-escaped ASCII punctuation, so the rendered output is unchanged.
 * Newlines are collapsed to spaces — fill values are single-line by contract
 * (multiline addresses are joined with commas by the caller/UI).
 */
export function escapeMarkdownValue(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_{}[\]()<>#+\-.!|~])/g, "\\$1");
}

/** Marker beginning the Exhibit C guarantor signature block in the MSA. */
const GUARANTOR_BLOCK_MARKER = "**GUARANTOR (individually)**";

const GUARANTY_NOT_EXECUTED_TEXT =
  "_Exhibit C was not executed as part of this signing. No personal guaranty was granted._";

const GUARANTY_FIELD_KEYS = ["guarantorName", "guarantorTitle", "guarantorAddress"] as const;

export type FillResult = {
  markdown: string;
  /** Required fields that had no value — signing must be rejected if non-empty. */
  missing: AgreementFieldDef[];
  /** Allow-listed tokens still present after filling — indicates a defect. */
  leftoverTokens: string[];
  /** Whether the optional Exhibit C guaranty was executed (MSA only). */
  guarantyExecuted: boolean;
};

/**
 * Fill an agreement template with the given values.
 *
 * - Replaces exactly the allow-listed tokens from `AGREEMENT_FIELDS[slot]`
 *   via split/join (tokens contain spaces — never use regex). The literal
 *   `[ALL-CAPS]` mention in the banner is not a token and is left alone.
 * - Values are markdown-escaped so they render as plain text.
 * - MSA: when no guarantor name is provided, the Exhibit C signature block is
 *   replaced with a "not executed" note and guarantor fields are skipped.
 */
export function fillAgreement(
  slot: AgreementSlot,
  values: Record<string, string | undefined>,
  options?: {
    /**
     * Override the bundled template. Clients pass the template the SERVER
     * returned, so a stale browser bundle previews (and therefore signs) the
     * same document text the server will record — never its own older copy.
     */
    template?: string;
  },
): FillResult {
  let markdown: string = options?.template ?? LEGAL_TEMPLATES[slot];
  const defs = AGREEMENT_FIELDS[slot];
  const missing: AgreementFieldDef[] = [];

  const guarantyExecuted =
    slot === "msa" && Boolean(values["guarantorName"]?.trim());

  if (slot === "msa" && !guarantyExecuted) {
    const idx = markdown.indexOf(GUARANTOR_BLOCK_MARKER);
    if (idx !== -1) {
      markdown = markdown.slice(0, idx) + GUARANTY_NOT_EXECUTED_TEXT + "\n";
    }
  }

  for (const def of defs) {
    const isGuarantyField = (GUARANTY_FIELD_KEYS as readonly string[]).includes(def.key);
    if (isGuarantyField && !guarantyExecuted) continue;

    const raw = values[def.key]?.trim() || def.defaultValue || "";
    // Guaranty fields become required as a set once a guarantor is named.
    const required = def.required || (isGuarantyField && guarantyExecuted);
    if (!raw) {
      if (required) missing.push(def);
      continue;
    }
    markdown = markdown.split(def.token).join(escapeMarkdownValue(raw));
  }

  const leftoverTokens = defs
    .filter((d) => markdown.includes(d.token))
    .map((d) => d.token);

  return { markdown, missing, leftoverTokens, guarantyExecuted };
}
