/**
 * Field metadata for the fillable SOBBU platform agreements.
 *
 * Each agreement template (see `templates.generated.ts`, regenerated from
 * `legal/*.md`) contains bracketed `[ALL-CAPS]` tokens. The signing flow
 * replaces exactly the allow-listed tokens below — nothing else — so the
 * literal `[ALL-CAPS]` mention inside the "not legal advice" banner is never
 * treated as a fill target.
 *
 * This module is intentionally free of node-only imports so the admin portal
 * can consume the same definitions for the signing form and live preview.
 */

export const AGREEMENT_SLOTS = ["msa", "user_agreement"] as const;
export type AgreementSlot = (typeof AGREEMENT_SLOTS)[number];

export const AGREEMENT_TITLES: Record<AgreementSlot, string> = {
  msa: "Master Subscription Agreement",
  user_agreement: "User Agreement (Terms of Service / EULA)",
};

/** Base file name (no extension) shared by the markdown source and the PDFs. */
export const AGREEMENT_FILE_BASES: Record<AgreementSlot, string> = {
  msa: "SecureOps-Command-Master-Subscription-Agreement",
  user_agreement: "SecureOps-Command-User-Agreement",
};

export type AgreementFieldGroup =
  | "customer"
  | "commercial"
  | "terms"
  | "provider"
  | "guaranty";

export const AGREEMENT_FIELD_GROUP_LABELS: Record<AgreementFieldGroup, string> = {
  customer: "Customer details",
  commercial: "Commercial terms (Exhibit A — Order Form)",
  terms: "Agreement terms",
  provider: "SOBBU (provider) details",
  guaranty: "Personal Guaranty (Exhibit C — optional)",
};

/**
 * Who supplies a field's value.
 *
 * - `provider` — SOBBU's to set: pricing, commercial terms, agreement terms
 *   and SOBBU's own entity details. The server derives these from platform
 *   configuration and NEVER accepts a signer-supplied value for them, so a
 *   customer cannot rewrite the deal they are signing.
 * - `customer` — completed by the signing organization (currently only the
 *   optional Exhibit C guarantor's own details, alongside the acceptance
 *   inputs, which are not fill fields at all).
 */
export type AgreementFieldAuthority = "provider" | "customer";

export type AgreementFieldDef = {
  /** Stable camelCase key used in API payloads and stored fieldsJson. */
  key: string;
  /** Exact bracketed token in the markdown template. */
  token: string;
  label: string;
  group: AgreementFieldGroup;
  /** Required to sign. Guaranty fields are conditionally required as a set. */
  required: boolean;
  /** Who sets the value — see AgreementFieldAuthority. */
  authority: AgreementFieldAuthority;
  /** Static default applied when the value is blank (prefill may override). */
  defaultValue?: string;
  hint?: string;
  multiline?: boolean;
};

/**
 * The only fields the signing customer fills in themselves. Everything else
 * is provider-set by default, so a newly added term is locked unless it is
 * deliberately listed here.
 */
const CUSTOMER_AUTHORITY_KEYS: ReadonlySet<string> = new Set([
  "guarantorName",
  "guarantorTitle",
  "guarantorAddress",
]);

function withAuthority(defs: Omit<AgreementFieldDef, "authority">[]): AgreementFieldDef[] {
  return defs.map((def) => ({
    ...def,
    authority: CUSTOMER_AUTHORITY_KEYS.has(def.key) ? "customer" : "provider",
  }));
}

export const AGREEMENT_FIELDS: Record<AgreementSlot, AgreementFieldDef[]> = {
  msa: withAuthority([
    {
      key: "customerLegalName",
      token: "[CUSTOMER LEGAL NAME]",
      label: "Customer legal name",
      group: "customer",
      required: true,
      hint: "The customer organization's full legal entity name.",
    },
    {
      key: "effectiveDate",
      token: "[EFFECTIVE DATE]",
      label: "Effective date",
      group: "customer",
      required: true,
    },
    {
      key: "orgCode",
      token: "[ORG CODE]",
      label: "Organization code",
      group: "customer",
      required: true,
      hint: "The short org code used to connect the mobile app.",
    },
    {
      key: "customerDomain",
      token: "[CUSTOMER DOMAIN]",
      label: "Deployment domain",
      group: "customer",
      required: true,
      hint: "The customer's dedicated deployment URL.",
    },
    {
      key: "planTier",
      token: "[TIER]",
      label: "Subscription tier",
      group: "commercial",
      required: true,
    },
    {
      key: "feeAmount",
      token: "[AMOUNT]",
      label: "Subscription fee",
      group: "commercial",
      required: true,
      hint: "e.g. $899.00",
    },
    {
      key: "billingPeriod",
      token: "[BILLING PERIOD]",
      label: "Billing period",
      group: "commercial",
      required: true,
      defaultValue: "month",
    },
    {
      key: "initialTerm",
      token: "[TERM]",
      label: "Initial term",
      group: "commercial",
      required: true,
      defaultValue: "12 months",
    },
    {
      key: "paymentTermDays",
      token: "[PAYMENT TERM DAYS]",
      label: "Payment terms (days)",
      group: "commercial",
      required: true,
      defaultValue: "30",
      hint: "Invoices are due this many days after the invoice date (Net X).",
    },
    {
      key: "billingContact",
      token: "[BILLING CONTACT NAME / EMAIL]",
      label: "Billing contact (name / email)",
      group: "commercial",
      required: true,
    },
    {
      key: "invoiceDisputeDays",
      token: "[INVOICE DISPUTE DAYS]",
      label: "Invoice dispute window (days)",
      group: "terms",
      required: true,
      defaultValue: "10",
    },
    {
      key: "lateFeeRatePercent",
      token: "[LATE-FEE RATE PERCENT]",
      label: "Late-fee rate (% per month)",
      group: "terms",
      required: true,
      defaultValue: "1.5",
    },
    {
      key: "nonpaymentNoticeDays",
      token: "[NONPAYMENT NOTICE DAYS]",
      label: "Nonpayment suspension notice (days)",
      group: "terms",
      required: true,
      defaultValue: "10",
    },
    {
      key: "renewalNoticeDays",
      token: "[RENEWAL NOTICE DAYS]",
      label: "Non-renewal notice (days)",
      group: "terms",
      required: true,
      defaultValue: "60",
    },
    {
      key: "curePeriodDays",
      token: "[CURE PERIOD DAYS]",
      label: "Breach cure period (days)",
      group: "terms",
      required: true,
      defaultValue: "30",
    },
    {
      key: "exportWindowDays",
      token: "[EXPORT WINDOW DAYS]",
      label: "Post-termination export window (days)",
      group: "terms",
      required: true,
      defaultValue: "30",
    },
    {
      key: "capMonths",
      token: "[CAP MONTHS]",
      label: "Liability cap (months of fees)",
      group: "terms",
      required: true,
      defaultValue: "12",
    },
    {
      key: "venueCounty",
      token: "[SOBBU VENUE COUNTY]",
      label: "Venue county (Texas)",
      group: "provider",
      required: true,
      hint: "The Texas county for exclusive venue, e.g. Harris.",
    },
    {
      key: "noticeEmail",
      token: "[NOTICE EMAIL]",
      label: "SOBBU notices email",
      group: "provider",
      required: true,
    },
    {
      key: "providerAddress",
      token: "[SOBBU PRINCIPAL ADDRESS]",
      label: "SOBBU principal address",
      group: "provider",
      required: true,
      multiline: true,
    },
    {
      key: "guarantorName",
      token: "[GUARANTOR NAME]",
      label: "Guarantor name",
      group: "guaranty",
      required: false,
    },
    {
      key: "guarantorTitle",
      token: "[GUARANTOR TITLE]",
      label: "Guarantor title / relationship to Customer",
      group: "guaranty",
      required: false,
    },
    {
      key: "guarantorAddress",
      token: "[GUARANTOR ADDRESS]",
      label: "Guarantor address",
      group: "guaranty",
      required: false,
      multiline: true,
    },
  ]),
  user_agreement: withAuthority([
    {
      key: "effectiveDate",
      token: "[EFFECTIVE DATE]",
      label: "Effective date",
      group: "customer",
      required: true,
    },
    {
      key: "liabilityCap",
      token: "[USER LIABILITY CAP USD]",
      label: "Per-user liability cap (USD)",
      group: "terms",
      required: true,
      defaultValue: "$100",
    },
    {
      key: "arbitrationCity",
      token: "[ARBITRATION CITY]",
      label: "Arbitration city (Texas)",
      group: "provider",
      required: true,
    },
    {
      key: "venueCounty",
      token: "[SOBBU VENUE COUNTY]",
      label: "Venue county (Texas)",
      group: "provider",
      required: true,
    },
    {
      key: "contactEmail",
      token: "[SOBBU CONTACT EMAIL]",
      label: "SOBBU contact email",
      group: "provider",
      required: true,
    },
    {
      key: "providerAddress",
      token: "[SOBBU PRINCIPAL ADDRESS]",
      label: "SOBBU principal address",
      group: "provider",
      required: true,
      multiline: true,
    },
  ]),
};

/**
 * The verbatim consent text presented next to the signature checkbox. Stored
 * with each signature record so the exact consent language is provable later.
 */
export const AGREEMENT_CONSENT_TEXTS: Record<AgreementSlot, string> = {
  msa: "I confirm that I am authorized to sign on behalf of the customer organization named in this agreement, that I have read and agree to the SecureOps Command Master Subscription Agreement as completed above (including its Exhibits), and that typing my name below constitutes my legally binding electronic signature.",
  user_agreement:
    "I confirm that I am authorized to accept on behalf of my organization, that I have read and agree to the SecureOps Command User Agreement as completed above, and that typing my name below constitutes my legally binding electronic signature.",
};

/**
 * The verbatim consent text for the optional Exhibit C Personal Guaranty.
 * Presented and stored only when a guarantor executes the guaranty.
 */
export const GUARANTY_CONSENT_TEXT =
  "I am signing Exhibit C in my personal, individual capacity. I have read the Personal Guaranty, understand that it makes me personally liable for the Customer's payment obligations under this Agreement, and agree that typing my name below constitutes my legally binding electronic signature as Guarantor.";
