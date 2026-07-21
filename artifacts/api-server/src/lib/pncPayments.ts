/**
 * PNC Bank Multipayments API client.
 *
 * Handles:
 *  - OAuth2 client-credentials token fetch + in-process cache
 *  - Submit a multipayment batch (POST /api/mlp/v1/payments)
 *  - Query payment status by customerReference (GET /api/mlp/v1/payments?customerReference=)
 *
 * All WCSG instructor-level fields (account number, routing, name, address)
 * come from environment variables — never from the database.
 *
 * Set PNC_API_BASE_URL to override the default production URL (useful for PNC sandbox).
 */

import { logger } from "./logger";

const PNC_BASE_URL = process.env["PNC_API_BASE_URL"] ?? "https://api.pnc.com";

// ── OAuth2 token cache ────────────────────────────────────────────────────────

type TokenCache = {
  accessToken: string;
  expiresAt: number; // epoch ms
};

let _tokenCache: TokenCache | null = null;

async function fetchToken(): Promise<string> {
  const clientId = process.env["PNC_CLIENT_ID"];
  const clientSecret = process.env["PNC_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error("PNC_CLIENT_ID and PNC_CLIENT_SECRET must be set");
  }

  const url = `${PNC_BASE_URL}/secoauth2/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PNC token request failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("PNC token response missing access_token");
  }

  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  // Cache until 60 seconds before actual expiry.
  const expiresAt = Date.now() + (expiresIn - 60) * 1000;

  _tokenCache = { accessToken: data.access_token, expiresAt };
  return data.access_token;
}

async function getToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.accessToken;
  }
  return fetchToken();
}

// ── Instructor config (WCSG source account) ───────────────────────────────────

export function getInstructorConfig() {
  return {
    companyId: process.env["PNC_COMPANY_ID"] ?? "",
    accountNumber: process.env["PNC_INSTRUCTOR_ACCOUNT_NUMBER"] ?? "",
    routingNumber: process.env["PNC_INSTRUCTOR_ROUTING_NUMBER"] ?? "",
    name: process.env["PNC_INSTRUCTOR_NAME"] ?? "",
    addressStreet: process.env["PNC_INSTRUCTOR_ADDRESS_STREET"] ?? "",
    addressCity: process.env["PNC_INSTRUCTOR_ADDRESS_CITY"] ?? "",
    addressState: process.env["PNC_INSTRUCTOR_ADDRESS_STATE"] ?? "",
    addressZip: process.env["PNC_INSTRUCTOR_ADDRESS_ZIP"] ?? "",
  };
}

export function isPncConfigured(): boolean {
  return Boolean(
    process.env["PNC_CLIENT_ID"] &&
      process.env["PNC_CLIENT_SECRET"] &&
      process.env["PNC_INSTRUCTOR_ACCOUNT_NUMBER"] &&
      process.env["PNC_INSTRUCTOR_ROUTING_NUMBER"],
  );
}

// ── Payment instruction mapper ────────────────────────────────────────────────

export type PayrollRowForPnc = {
  id: string;
  employeeId: string;
  employeeName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankBsb: string | null;
  netPay: string;
  periodStart: string;
};

export type PncInstruction = {
  instructionId: string;
  payments: PncPayment[];
};

export type PncPayment = {
  customerReference: string;
  instructee: { name: string };
  instructeeAccount: {
    accountNumber: string;
    accountType: "SACC";
    currency: "USD";
  };
  instructeeAgent: { routingNumber: string };
  transferAmount: { amount: string; currency: "USD" };
  preferredPaymentType: "ACH";
  accountingEntry: "CREDIT";
  requestedExecutionDate: string;
};

export type RowMapResult =
  | { ok: true; instruction: PncInstruction; customerReference: string }
  | { ok: false; reason: string };

export function mapRowToInstruction(row: PayrollRowForPnc): RowMapResult {
  if (!row.bankAccountNumber?.trim()) {
    return { ok: false, reason: "Missing bank account number" };
  }
  if (!row.bankBsb?.trim()) {
    return { ok: false, reason: "Missing routing number" };
  }
  if (!row.bankAccountName?.trim()) {
    return { ok: false, reason: "Missing bank account name" };
  }

  const today = new Date().toISOString().slice(0, 10);
  // customerReference must be unique per payroll entry: include the full entry ID
  // so two entries for the same employee in the same period never collide.
  const customerReference = `WCSG-${row.employeeId}-${row.id}-${row.periodStart}`;
  const instructionId = `INS-${row.id}-${row.periodStart}`;

  const payment: PncPayment = {
    customerReference,
    instructee: { name: row.bankAccountName.trim() },
    instructeeAccount: {
      accountNumber: row.bankAccountNumber.trim(),
      accountType: "SACC",
      currency: "USD",
    },
    instructeeAgent: { routingNumber: row.bankBsb.trim() },
    transferAmount: {
      amount: Number(row.netPay).toFixed(2),
      currency: "USD",
    },
    preferredPaymentType: "ACH",
    accountingEntry: "CREDIT",
    requestedExecutionDate: today,
  };

  return {
    ok: true,
    instruction: { instructionId, payments: [payment] },
    customerReference,
  };
}

// ── API calls ─────────────────────────────────────────────────────────────────

export type SubmitResult =
  | { ok: true; multipaymentId: string; raw: unknown }
  | { ok: false; errors: unknown; raw: unknown };

export async function submitMultipayment(
  multipaymentId: string,
  instructions: PncInstruction[],
): Promise<SubmitResult> {
  const token = await getToken();
  const url = `${PNC_BASE_URL}/api/mlp/v1/payments`;

  const instructor = getInstructorConfig();
  // PNC MLP API expects instructor details nested under a top-level `instructor`
  // object. instructorAccount/instructorAgent carry the WCSG source account;
  // instructorAgent.routingNumber identifies the originating bank.
  const body = {
    multipaymentId,
    mode: "sync",
    instructor: {
      instructorId: instructor.companyId || undefined,
      instructorName: instructor.name || undefined,
      instructorAddress: (instructor.addressStreet || instructor.addressCity || instructor.addressState || instructor.addressZip)
        ? {
            street: instructor.addressStreet || undefined,
            city: instructor.addressCity || undefined,
            state: instructor.addressState || undefined,
            zip: instructor.addressZip || undefined,
          }
        : undefined,
      instructorAccount: {
        accountNumber: instructor.accountNumber,
        accountType: "CACC",
        currency: "USD",
      },
      instructorAgent: {
        routingNumber: instructor.routingNumber,
      },
    },
    instructions,
  };

  logger.info({ multipaymentId, count: instructions.length }, "Submitting PNC multipayment");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await res.json().catch(() => null);

  if (!res.ok) {
    logger.warn({ multipaymentId, status: res.status, raw }, "PNC multipayment submission failed");
    return { ok: false, errors: raw, raw };
  }

  logger.info({ multipaymentId, status: res.status }, "PNC multipayment submitted successfully");
  return { ok: true, multipaymentId, raw };
}

export async function getPaymentStatusByCustomerRef(customerReference: string): Promise<unknown> {
  const token = await getToken();
  const url = `${PNC_BASE_URL}/api/mlp/v1/payments?customerReference=${encodeURIComponent(customerReference)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PNC status check failed (${res.status}): ${text}`);
  }

  return res.json();
}
