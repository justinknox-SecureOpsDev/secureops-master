import { randomBytes } from "node:crypto";

/**
 * Proof that an admin actually looked at an invoice email before it was sent.
 *
 * The send route will not email anything without a ticket, and a ticket is only
 * ever handed out by the preview route. A boolean "confirmed: true" flag would
 * be trivially satisfied by any caller that never rendered a preview — a
 * one-time ticket bound to a specific invoice, admin, and exact email content
 * cannot be.
 *
 * **Why in memory:** these are short-lived (minutes) and only meaningful within
 * the process that issued them. Losing them on restart fails CLOSED — the admin
 * is asked to review again, which is the safe direction. Do not "fix" that by
 * relaxing the check.
 */

export const TICKET_TTL_MS = 30 * 60 * 1000;

type Ticket = {
  invoiceId: string;
  userId: string;
  /** Fingerprint of the email content shown in the preview. */
  digest: string;
  expiresAt: number;
};

const tickets = new Map<string, Ticket>();

function sweep(now: number): void {
  for (const [token, t] of tickets) {
    if (t.expiresAt <= now) tickets.delete(token);
  }
}

export function issueSendTicket(
  invoiceId: string,
  userId: string,
  digest: string,
  now: number = Date.now(),
): string {
  sweep(now);
  const token = randomBytes(24).toString("hex");
  tickets.set(token, { invoiceId, userId, digest, expiresAt: now + TICKET_TTL_MS });
  return token;
}

export type TicketRejection =
  | "missing"
  | "unknown"
  | "expired"
  | "wrong_invoice"
  | "wrong_user"
  | "stale_content";

export type TicketRedemption =
  | { ok: true }
  | { ok: false; reason: TicketRejection };

/**
 * Consume a ticket. Single-use: a valid ticket is removed even though the send
 * may still fail downstream, so one review cannot authorise two emails.
 */
export function redeemSendTicket(
  token: string | undefined | null,
  invoiceId: string,
  userId: string,
  digest: string,
  now: number = Date.now(),
): TicketRedemption {
  if (!token) return { ok: false, reason: "missing" };

  const ticket = tickets.get(token);
  if (!ticket) return { ok: false, reason: "unknown" };

  if (ticket.expiresAt <= now) {
    tickets.delete(token);
    return { ok: false, reason: "expired" };
  }
  // A ticket for one invoice must never authorise another.
  if (ticket.invoiceId !== invoiceId) return { ok: false, reason: "wrong_invoice" };
  if (ticket.userId !== userId) return { ok: false, reason: "wrong_user" };
  // The invoice changed between review and confirm — the admin approved
  // different numbers than the ones about to be billed.
  if (ticket.digest !== digest) {
    tickets.delete(token);
    return { ok: false, reason: "stale_content" };
  }

  tickets.delete(token);
  return { ok: true };
}

/** Human-readable reason, surfaced to the admin so they know what to do next. */
export function ticketRejectionMessage(reason: TicketRejection): string {
  switch (reason) {
    case "missing":
      return "This invoice email has not been reviewed. Open the invoice, check the preview, then confirm to send.";
    case "stale_content":
      return "This invoice changed after you previewed it. Review the updated email before sending.";
    case "expired":
    case "unknown":
      return "Your review of this invoice expired. Open the preview again and confirm to send.";
    case "wrong_invoice":
      return "That confirmation belongs to a different invoice. Review this invoice's email before sending.";
    case "wrong_user":
      return "That confirmation was made by a different admin. Review the email yourself before sending.";
  }
}

/** Test seam — drops all outstanding tickets. */
export function __resetSendTickets(): void {
  tickets.clear();
}
