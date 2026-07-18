import nodemailer, { type Transporter } from "nodemailer";
import { Resend } from "resend";
import { logger } from "./logger";
import { brand } from "./brandConfig";

/**
 * Env-gated email sender. Two transports — Resend and SMTP. Which one is tried
 * first is controlled by EMAIL_PROVIDER:
 *
 *   EMAIL_PROVIDER=smtp   → SMTP first (e.g. Gmail / Google Workspace), Resend
 *                           as automatic fallback if SMTP isn't configured or
 *                           the send fails.
 *   EMAIL_PROVIDER=resend → Resend only.
 *   EMAIL_PROVIDER=auto   → (default) Resend first, SMTP fallback. Preserves the
 *                           original behaviour for existing deployments.
 *
 *   Resend config:  RESEND_API_KEY, RESEND_FROM (or falls back to SMTP_FROM)
 *   SMTP config:    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * A "failed" send (transport/auth/quota error) falls through to the other
 * provider; a "bounced" send (recipient rejected) does NOT — retrying a bad
 * recipient on a second provider would just bounce again.
 *
 * If neither is configured, `sendEmail` returns false and logs a single info line —
 * callers fall back to surfacing the link/credentials in the API response so the
 * admin can share them manually.
 */

type EmailProviderPref = "smtp" | "resend" | "auto";

function emailProviderPref(): EmailProviderPref {
  const v = (process.env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (v === "smtp" || v === "resend") return v;
  return "auto";
}

let cachedSmtp: Transporter | null = null;
let cachedResend: Resend | null = null;
let warned = false;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (cachedResend) return cachedResend;
  cachedResend = new Resend(process.env.RESEND_API_KEY);
  return cachedResend;
}

function getTransport(): Transporter | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    if (!warned && !process.env.RESEND_API_KEY) {
      logger.info("Neither RESEND_API_KEY nor SMTP_* configured — emails will not be sent (admins must share links manually).");
      warned = true;
    }
    return null;
  }
  if (cachedSmtp) return cachedSmtp;
  cachedSmtp = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return cachedSmtp;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  /**
   * When set, the attachment is embedded inline and can be referenced from the
   * HTML body via `cid:<cid>` (e.g. an inline QR image). Maps to nodemailer's
   * `cid` and Resend's `contentId`. Omit for ordinary file attachments.
   */
  cid?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
}

/**
 * Detailed outcome of an SMTP handoff.
 *
 *   status:
 *     - "not_configured" — SMTP env vars missing; nothing was attempted.
 *     - "sent"           — SMTP accepted the message with no rejected recipients.
 *     - "bounced"        — SMTP rejected one or more recipients (synchronous bounce).
 *                          Asynchronous bounces (delivery later refused by the
 *                          recipient's MTA) are NOT captured here — those require
 *                          provider webhooks (e.g. SendGrid Event API). The
 *                          schema columns are nonetheless designed so a webhook
 *                          handler can flip the row to "bounced" later.
 *     - "failed"         — transport threw (network/auth/timeout).
 *     - "suppressed"     — non-production environment; nothing was sent on purpose
 *                          (see `emailSendingEnabled`). `ok` is true so scheduled
 *                          jobs treat the reminder as handled and don't roll back /
 *                          retry every tick, but the status records that no mail
 *                          actually left the building.
 */
export type EmailSendStatus = "not_configured" | "sent" | "bounced" | "failed" | "suppressed";

export interface EmailSendResult {
  status: EmailSendStatus;
  ok: boolean;
  messageId: string | null;
  response: string | null;
  rejected: string[];
  error: string | null;
}

// Returns null when this provider isn't configured (so the caller can try the
// other one); otherwise the concrete send outcome.
async function sendViaResend(msg: EmailMessage): Promise<EmailSendResult | null> {
  const resend = getResend();
  if (!resend) return null;
  const from = process.env.RESEND_FROM || process.env.SMTP_FROM || `${brand.companyName} <onboarding@resend.dev>`;
  try {
    const { data, error } = await resend.emails.send({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
        ...(a.cid ? { contentId: a.cid } : {}),
      })),
    });
    if (error) {
      // Resend's API returns name+message on validation/auth errors AND on
      // recipient-rejection failures. Only treat *recipient-specific* rejections
      // as a synchronous bounce (retrying those on another provider would just
      // bounce again). Domain/sender/config errors (e.g. "domain not verified")
      // are NOT recipient bounces — leave them as "failed" so the orchestrator
      // can fall through to the other provider (e.g. SMTP).
      const errStr = `${error.name}: ${error.message}`;
      const looksBounced = /invalid.*(recipient|to|email)|address.*not.*exist/i.test(errStr);
      if (looksBounced) {
        logger.warn({ to: msg.to, error: errStr }, "Resend rejected recipient");
        return { status: "bounced", ok: false, messageId: null, response: errStr, rejected: [msg.to], error: null };
      }
      logger.error({ to: msg.to, error: errStr }, "Resend send failed");
      return { status: "failed", ok: false, messageId: null, response: null, rejected: [], error: errStr };
    }
    return { status: "sent", ok: true, messageId: data?.id ?? null, response: null, rejected: [], error: null };
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger.error({ err, to: msg.to }, "Failed to send email via Resend");
    return { status: "failed", ok: false, messageId: null, response: null, rejected: [], error };
  }
}

async function sendViaSmtp(msg: EmailMessage): Promise<EmailSendResult | null> {
  const t = getTransport();
  if (!t) return null;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER!;
  try {
    const info = await t.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
        ...(a.cid ? { cid: a.cid } : {}),
      })),
    });
    const rejected = Array.isArray(info.rejected) ? info.rejected.map(String) : [];
    const messageId = typeof info.messageId === "string" ? info.messageId : null;
    const response = typeof info.response === "string" ? info.response : null;
    if (rejected.length > 0) {
      logger.warn({ to: msg.to, rejected, response }, "SMTP rejected recipient(s)");
      return { status: "bounced", ok: false, messageId, response, rejected, error: null };
    }
    return { status: "sent", ok: true, messageId, response, rejected: [], error: null };
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger.error({ err, to: msg.to }, "Failed to send email");
    return { status: "failed", ok: false, messageId: null, response: null, rejected: [], error };
  }
}

/**
 * Outbound email is only actually delivered in production. In any non-production
 * environment (the Replit dev workspace, preview deploys, etc.) the send is
 * suppressed and logged instead — otherwise every server restart, scheduled job,
 * or code path exercised during development would flood the real admin/HR inboxes
 * with live mail. Set EMAIL_DEV_SEND=true to force real delivery in dev when
 * deliberately testing the email pipeline.
 */
function emailSendingEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return (process.env.EMAIL_DEV_SEND ?? "").trim().toLowerCase() === "true";
}

export async function sendEmailDetailed(msg: EmailMessage): Promise<EmailSendResult> {
  if (!emailSendingEnabled()) {
    logger.info(
      { to: msg.to, subject: msg.subject },
      "Email suppressed (non-production environment). Set EMAIL_DEV_SEND=true to send.",
    );
    return { status: "suppressed", ok: true, messageId: null, response: "suppressed:non-production", rejected: [], error: null };
  }

  const pref = emailProviderPref();
  const order: Array<"smtp" | "resend"> =
    pref === "smtp" ? ["smtp", "resend"] : pref === "resend" ? ["resend"] : ["resend", "smtp"];

  let lastFailure: EmailSendResult | null = null;
  for (const provider of order) {
    const result = provider === "smtp" ? await sendViaSmtp(msg) : await sendViaResend(msg);
    if (result === null) continue; // provider not configured — try the next one
    // Success, or a hard bounce (retrying a rejected recipient elsewhere would
    // just bounce again) — return immediately.
    if (result.ok || result.status === "bounced") return result;
    // Transient/transport failure (auth, quota, network) — remember it and let
    // the next provider try.
    lastFailure = result;
  }

  return (
    lastFailure ?? { status: "not_configured", ok: false, messageId: null, response: null, rejected: [], error: null }
  );
}

export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const r = await sendEmailDetailed(msg);
  return r.ok;
}

export function renderOnboardingEmail(opts: {
  firstName: string;
  onboardingUrl: string;
  email: string;
  tempPassword: string;
}): { subject: string; text: string; html: string } {
  const subject = `Welcome to ${brand.companyName} — complete your onboarding`;
  const text = [
    `Hi ${opts.firstName},`,
    "",
    "Your application has been approved. To finish onboarding, please complete the secure form below.",
    "",
    `Onboarding link (single use, expires in 14 days): ${opts.onboardingUrl}`,
    "",
    `After onboarding you can sign in to the ${brand.appName} app with:`,
    `  Email:              ${opts.email}`,
    `  Temporary password: ${opts.tempPassword}`,
    "(You will be asked to set a new password on first login.)",
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08">Welcome to ${brand.companyName}</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Your application has been approved. To finish onboarding, please complete the secure form below.</p>
      <p style="margin:24px 0">
        <a href="${escapeAttr(opts.onboardingUrl)}"
           style="background:#c9a04a;color:#0c0a08;padding:12px 20px;text-decoration:none;font-weight:bold;border-radius:4px">
          Complete onboarding
        </a>
      </p>
      <p style="color:#555">This link is single use and expires in 14 days.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p>After onboarding, sign in to the ${brand.appName} app with:</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a04a;margin:12px 0;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px">
        <div><strong>Email:</strong> ${escapeHtml(opts.email)}</div>
        <div><strong>Temporary password:</strong> ${escapeHtml(opts.tempPassword)}</div>
      </div>
      <p style="color:#555;font-size:12px">You will be asked to set a new password on first login.</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderResendOnboardingEmail(opts: {
  firstName: string;
  onboardingUrl: string;
}): { subject: string; text: string; html: string } {
  const subject = `Your ${brand.companyName} onboarding link`;
  const text = [
    `Hi ${opts.firstName},`,
    "",
    "Here is a fresh link to complete your onboarding (single use, expires in 14 days):",
    "",
    opts.onboardingUrl,
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08">${brand.companyName}</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Here is a fresh link to complete your onboarding.</p>
      <p style="margin:24px 0">
        <a href="${escapeAttr(opts.onboardingUrl)}"
           style="background:#c9a04a;color:#0c0a08;padding:12px 20px;text-decoration:none;font-weight:bold;border-radius:4px">
          Complete onboarding
        </a>
      </p>
      <p style="color:#555">This link is single use and expires in 14 days.</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderRejectionEmail(opts: {
  firstName: string;
  reviewerNotes?: string | null;
}): { subject: string; text: string; html: string } {
  const subject = `Update on your ${brand.companyName} application`;
  const notesBlock = opts.reviewerNotes && opts.reviewerNotes.trim().length > 0
    ? `\n\nNotes from our recruitment team:\n${opts.reviewerNotes.trim()}\n`
    : "";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    `Thank you for taking the time to apply to ${brand.companyName}.`,
    "",
    "After careful consideration, we won't be moving forward with your application at this time.",
    "We genuinely appreciate your interest and the effort you put into applying, and we wish you the very best in your job search.",
    notesBlock,
    "You're welcome to apply again in the future as new positions open up.",
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const notesHtml = opts.reviewerNotes && opts.reviewerNotes.trim().length > 0
    ? `<div style="background:#f6f1e1;padding:12px;border-left:3px solid #c9a04a;margin:16px 0;border-radius:4px">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#555;margin-bottom:6px">Notes from our team</div>
         <div style="white-space:pre-wrap">${escapeHtml(opts.reviewerNotes.trim())}</div>
       </div>`
    : "";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08">${brand.companyName}</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Thank you for taking the time to apply to ${brand.companyName}.</p>
      <p>After careful consideration, we won't be moving forward with your application at this time.
         We genuinely appreciate your interest and the effort you put into applying, and we wish you the very best in your job search.</p>
      ${notesHtml}
      <p style="color:#555">You're welcome to apply again in the future as new positions open up.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— ${brand.companyName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderApplicationReceivedEmail(opts: {
  firstName: string;
  reviewWindowDays?: number;
}): { subject: string; text: string; html: string } {
  const days = opts.reviewWindowDays ?? 5;
  const subject = `We've received your application — ${brand.companyName}`;
  const text = [
    `Hi ${opts.firstName},`,
    "",
    `Thanks for applying to ${brand.companyName}. This is a quick note to confirm we've received your application.`,
    "",
    `Our recruitment team will review your submission within ${days} business days and be in touch with next steps. If we need anything else from you in the meantime, we'll reach out by email or phone.`,
    "",
    "There's no need to reply to this message.",
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08;background:#f0e4c0;padding:24px;border-radius:6px">
      <h2 style="color:#0c0a08;margin-top:0">${brand.companyName}</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Thanks for applying to ${brand.companyName}. This is a quick note to confirm we've received your application.</p>
      <p>Our recruitment team will review your submission within <strong>${days} business days</strong> and be in touch with next steps. If we need anything else from you in the meantime, we'll reach out by email or phone.</p>
      <p style="color:#555">There's no need to reply to this message.</p>
      <hr style="border:none;border-top:2px solid #c9a04a;margin:24px 0"/>
      <p style="color:#0c0a08;font-weight:bold;margin:0">${brand.companyName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderApplicationDraftResumeEmail(opts: {
  firstName: string | null;
  resumeUrl: string;
  expiresInDays: number;
}): { subject: string; text: string; html: string } {
  const hello = opts.firstName && opts.firstName.trim().length > 0
    ? `Hi ${opts.firstName.trim()},`
    : "Hi there,";
  const subject = `Pick up where you left off — ${brand.companyName} application`;
  const text = [
    hello,
    "",
    "Here's the secure link to resume your officer application. Your answers and uploaded documents are saved — you'll land right back on the step you were on.",
    "",
    `Resume link (expires in ${opts.expiresInDays} days):`,
    opts.resumeUrl,
    "",
    "If you didn't start an application, you can safely ignore this email.",
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08;background:#f0e4c0;padding:24px;border-radius:6px">
      <h2 style="color:#0c0a08;margin-top:0">${brand.companyName}</h2>
      <p>${escapeHtml(hello)}</p>
      <p>Here's the secure link to resume your officer application. Your answers and uploaded documents are saved — you'll land right back on the step you were on.</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${escapeAttr(opts.resumeUrl)}"
           style="display:inline-block;background:#0c0a08;color:#c9a04a;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">
          Resume my application
        </a>
      </p>
      <p style="color:#555;font-size:12px">This link expires in ${opts.expiresInDays} days. If the button doesn't work, paste this URL into your browser:<br/>
        <span style="word-break:break-all">${escapeHtml(opts.resumeUrl)}</span>
      </p>
      <p style="color:#555;font-size:12px">If you didn't start an application, you can safely ignore this email.</p>
      <hr style="border:none;border-top:2px solid #c9a04a;margin:24px 0"/>
      <p style="color:#0c0a08;font-weight:bold;margin:0">${brand.companyName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderRequestInfoEmail(opts: {
  firstName: string;
  amendUrl: string;
  note?: string | null;
  fieldLabels: string[];
}): { subject: string; text: string; html: string } {
  const subject = `We need a few more details on your application — ${brand.companyName}`;
  const fieldsList = opts.fieldLabels.map((l) => `  • ${l}`).join("\n");
  const noteBlock = opts.note && opts.note.trim().length > 0
    ? `\n\nNote from our team:\n${opts.note.trim()}\n`
    : "";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    `Thanks for applying to ${brand.companyName}. To finish reviewing your application, we need a few more details from you:`,
    "",
    fieldsList,
    noteBlock,
    "Please complete the missing items using the secure link below. The link expires in 14 days.",
    "",
    opts.amendUrl,
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const fieldsHtml = `<ul style="margin:8px 0 0 0;padding-left:20px">${
    opts.fieldLabels.map((l) => `<li style="margin:4px 0">${escapeHtml(l)}</li>`).join("")
  }</ul>`;
  const noteHtml = opts.note && opts.note.trim().length > 0
    ? `<div style="background:#f6f1e1;padding:12px;border-left:3px solid #c9a04a;margin:16px 0;border-radius:4px">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#555;margin-bottom:6px">Note from our team</div>
         <div style="white-space:pre-wrap">${escapeHtml(opts.note.trim())}</div>
       </div>`
    : "";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08;background:#f0e4c0;padding:24px;border-radius:6px">
      <h2 style="color:#0c0a08;margin-top:0">${brand.companyName}</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Thanks for applying. To finish reviewing your application, we need a few more details from you:</p>
      ${fieldsHtml}
      ${noteHtml}
      <p style="text-align:center;margin:24px 0">
        <a href="${escapeHtml(opts.amendUrl)}"
           style="display:inline-block;background:#0c0a08;color:#c9a04a;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">
          Complete missing details
        </a>
      </p>
      <p style="color:#555;font-size:12px">This secure link expires in 14 days. If the button doesn't work, paste this URL into your browser:<br/>
        <span style="word-break:break-all">${escapeHtml(opts.amendUrl)}</span>
      </p>
      <hr style="border:none;border-top:2px solid #c9a04a;margin:24px 0"/>
      <p style="color:#0c0a08;font-weight:bold;margin:0">${brand.companyName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderPasswordResetEmail(opts: {
  firstName: string;
  resetUrl: string;
  expiresInMinutes: number;
}): { subject: string; text: string; html: string } {
  const subject = `Reset your ${brand.companyName} password`;
  const text = [
    `Hi ${opts.firstName},`,
    "",
    `We received a request to reset the password on your ${brand.companyName} account.`,
    "",
    `Reset link (single use, expires in ${opts.expiresInMinutes} minutes):`,
    opts.resetUrl,
    "",
    "If you didn't request this, you can ignore this email — your password will stay the same.",
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08">Reset your password</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>We received a request to reset the password on your ${brand.companyName} account.</p>
      <p style="margin:24px 0">
        <a href="${escapeAttr(opts.resetUrl)}"
           style="background:#c9a04a;color:#0c0a08;padding:12px 20px;text-decoration:none;font-weight:bold;border-radius:4px">
          Choose a new password
        </a>
      </p>
      <p style="color:#555">This link is single use and expires in ${opts.expiresInMinutes} minutes.</p>
      <p style="color:#555;font-size:12px">If you didn't request this, you can ignore this email — your password will stay the same.</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderPasswordChangedEmail(opts: {
  firstName: string;
  changeType: "reset" | "change";
  whenIso: string;
  ip?: string | null;
  userAgent?: string | null;
  hrContact?: string;
}): { subject: string; text: string; html: string } {
  const action = opts.changeType === "reset" ? "reset" : "changed";
  const subject = `Your ${brand.companyName} password was just ${action}`;
  const hrContact = opts.hrContact ?? brand.hrEmail;
  const ipLine = opts.ip ? `Approximate location / IP: ${opts.ip}` : "Approximate location / IP: unknown";
  const uaLine = opts.userAgent ? `Device: ${opts.userAgent}` : "";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    `Your ${brand.companyName} password was just ${action}.`,
    "",
    `Time: ${opts.whenIso}`,
    ipLine,
    uaLine,
    "",
    `If this WAS you, no action is needed.`,
    `If this WASN'T you, contact HR immediately at ${hrContact} — your account may be compromised.`,
    "",
    `— ${brand.companyName}`,
  ].filter((l) => l !== "").join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08">Your password was just ${action}</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Your ${brand.companyName} password was just <strong>${action}</strong>.</p>
      <div style="background:#f6f1e1;padding:12px;border-left:3px solid #c9a04a;margin:16px 0;border-radius:4px;font-size:14px">
        <div><strong>Time:</strong> ${escapeHtml(opts.whenIso)}</div>
        <div><strong>Approximate location / IP:</strong> ${escapeHtml(opts.ip || "unknown")}</div>
        ${opts.userAgent ? `<div><strong>Device:</strong> ${escapeHtml(opts.userAgent)}</div>` : ""}
      </div>
      <p>If this <strong>was</strong> you, no action is needed.</p>
      <p style="color:#a33">If this <strong>wasn't</strong> you, contact HR immediately at
        <a href="mailto:${escapeAttr(hrContact)}">${escapeHtml(hrContact)}</a> — your account may be compromised.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— ${brand.companyName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderInviteEmail(opts: {
  firstName: string;
  email: string;
  tempPassword: string;
  appUrl?: string | null;
  /**
   * One-tap connect link in the form `<origin>/connect?code=<code>` (or the
   * `<scheme>://connect?code=<code>` deep link when no https origin is
   * configured). Lands the new hire on the org-connect screen with the
   * organization code prefilled. Omitted when the org code can't be resolved.
   */
  connectUrl?: string | null;
  /**
   * The organization code itself, shown as a fallback so staff can type it on
   * the Connect screen manually if the link / QR don't work.
   */
  orgCode?: string | null;
  /**
   * Content-ID of an inline QR image (attached separately) that encodes the
   * connect link. Referenced as `cid:<qrCid>`. Omitted when there's no QR.
   */
  qrCid?: string | null;
}): { subject: string; text: string; html: string } {
  const subject = `Welcome to ${brand.companyName} — your SecureOps login`;
  const text = [
    `Hi ${opts.firstName},`,
    "",
    `Your ${brand.companyName} account is ready in the SecureOps app.`,
    "",
    ...(opts.connectUrl
      ? [
          `Connect the SecureOps app to your team: ${opts.connectUrl}`,
          ...(opts.orgCode ? [`(Or enter organization code "${opts.orgCode}" on the Connect screen.)`] : []),
          "",
        ]
      : opts.appUrl
        ? [`Open the SecureOps app: ${opts.appUrl}`, ""]
        : []),
    "Sign in with the credentials below — you'll set a new password on your first sign-in.",
    "",
    `Email:              ${opts.email}`,
    `Temporary password: ${opts.tempPassword}`,
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08">Welcome to ${brand.companyName}</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Your account is ready in the <strong>SecureOps</strong> app. Open it and sign in with the credentials below — you'll set a new password on your first sign-in.</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a04a;margin:18px 0;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px">
        <div><strong>Email:</strong> ${escapeHtml(opts.email)}</div>
        <div><strong>Temporary password:</strong> ${escapeHtml(opts.tempPassword)}</div>
      </div>
      ${opts.connectUrl ? `
      <p style="text-align:center;margin:24px 0 12px">
        <a href="${escapeAttr(opts.connectUrl)}"
           style="display:inline-block;background:#0c0a08;color:#c9a04a;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">
          Connect the SecureOps app
        </a>
      </p>
      ${opts.qrCid ? `
      <p style="text-align:center;margin:8px 0 4px">
        <img src="cid:${escapeAttr(opts.qrCid)}" alt="Scan to connect the SecureOps app" width="180" height="180" style="width:180px;height:180px;border:1px solid #e6dcc0;border-radius:8px"/>
      </p>
      <p style="text-align:center;color:#555;font-size:12px;margin:0 0 8px">Scan this with your phone camera or in the SecureOps app to connect.</p>` : ""}
      ${opts.orgCode ? `<p style="text-align:center;color:#555;font-size:12px;margin:0">Or enter organization code <strong style="color:#0c0a08">${escapeHtml(opts.orgCode)}</strong> on the Connect screen.</p>` : ""}
      <p style="color:#555;font-size:12px">If the button doesn't work, paste this URL into your browser:<br/>
        <span style="word-break:break-all">${escapeHtml(opts.connectUrl)}</span>
      </p>` : opts.appUrl ? `
      <p style="text-align:center;margin:24px 0">
        <a href="${escapeAttr(opts.appUrl)}"
           style="display:inline-block;background:#0c0a08;color:#c9a04a;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">
          Open the SecureOps app
        </a>
      </p>
      <p style="color:#555;font-size:12px">If the button doesn't work, paste this URL into your browser:<br/>
        <span style="word-break:break-all">${escapeHtml(opts.appUrl)}</span>
      </p>` : ""}
      <hr style="border:none;border-top:2px solid #c9a04a;margin:24px 0"/>
      <p style="color:#0c0a08;font-weight:bold;margin:0">${brand.companyName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderTrainingExpiryEmail(opts: {
  firstName: string;
  trainingTitle: string;
  trainingType: string;
  expiryDate: string;
  daysRemaining: number;
}): { subject: string; text: string; html: string } {
  const urgency = opts.daysRemaining <= 7 ? "URGENT" : opts.daysRemaining <= 14 ? "Action needed" : "Reminder";
  const subject = `${urgency}: your ${opts.trainingTitle} certificate expires in ${opts.daysRemaining} days`;
  const text = [
    `Hi ${opts.firstName},`,
    "",
    `This is a friendly reminder that your ${opts.trainingTitle} (${opts.trainingType}) training certificate is due to expire soon.`,
    "",
    `  Certificate: ${opts.trainingTitle}`,
    `  Expires:     ${opts.expiryDate}`,
    `  Days left:   ${opts.daysRemaining}`,
    "",
    "Please refresh before the expiry date. An expired certificate may make you ineligible for sites that require this training.",
    "Once renewed, please upload the new certificate from the mobile app (Profile → My training).",
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const accent = opts.daysRemaining <= 7 ? "#a33" : "#c9a04a";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08">${escapeHtml(urgency)}: training renewal needed</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>This is a friendly reminder that your <strong>${escapeHtml(opts.trainingTitle)}</strong> certificate is due to expire soon.</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid ${accent};margin:18px 0;border-radius:4px">
        <div><strong>Certificate:</strong> ${escapeHtml(opts.trainingTitle)}</div>
        <div><strong>Type:</strong> ${escapeHtml(opts.trainingType)}</div>
        <div><strong>Expires:</strong> ${escapeHtml(opts.expiryDate)}</div>
        <div><strong>Days remaining:</strong> ${opts.daysRemaining}</div>
      </div>
      <p>Please refresh before the expiry date. An expired certificate may make you ineligible for sites that require this training.</p>
      <p>Once renewed, please upload the new certificate from the mobile app (Profile → My training).</p>
      <hr style="border:none;border-top:2px solid #c9a04a;margin:24px 0"/>
      <p style="color:#0c0a08;font-weight:bold;margin:0">${brand.companyName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderLicenseExpiryEmail(opts: {
  firstName: string;
  licenseType: string;
  licenseNumber: string;
  expiryDate: string;
  daysRemaining: number;
}): { subject: string; text: string; html: string } {
  const urgency = opts.daysRemaining <= 7 ? "URGENT" : opts.daysRemaining <= 14 ? "Action needed" : opts.daysRemaining <= 30 ? "Reminder" : "Start renewal now";
  const subject = `${urgency}: your ${opts.licenseType} license expires in ${opts.daysRemaining} days`;
  // The 60-day notice is intentionally the "start the paperwork" nudge —
  // Texas DPS renewal turnaround has been running long, so officers need
  // the full two months to file before the existing license lapses.
  const headline = opts.daysRemaining > 30
    ? `Texas DPS renewal can take several weeks right now — please start your ${opts.licenseType} license renewal today so you don't lose shift eligibility when it expires.`
    : `This is a reminder that your ${opts.licenseType} license is due to expire soon.`;
  const text = [
    `Hi ${opts.firstName},`,
    "",
    headline,
    "",
    `  License:    ${opts.licenseType} (${opts.licenseNumber})`,
    `  Expires:    ${opts.expiryDate}`,
    `  Days left:  ${opts.daysRemaining}`,
    "",
    "Please renew before the expiry date. An expired license means you cannot clock in or be assigned to qualifying shifts.",
    "If you have already renewed, please send a copy of the new license to HR so we can update your record.",
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const accent = opts.daysRemaining <= 7 ? "#a33" : "#c9a04a";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08">${escapeHtml(urgency)}: license renewal needed</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>${escapeHtml(headline)}</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid ${accent};margin:18px 0;border-radius:4px">
        <div><strong>License:</strong> ${escapeHtml(opts.licenseType)} (${escapeHtml(opts.licenseNumber)})</div>
        <div><strong>Expires:</strong> ${escapeHtml(opts.expiryDate)}</div>
        <div><strong>Days remaining:</strong> ${opts.daysRemaining}</div>
      </div>
      <p>Please renew before the expiry date. An expired license means you cannot clock in or be assigned to qualifying shifts.</p>
      <p style="color:#555;font-size:13px">If you have already renewed, please send a copy of the new license to HR so we can update your record.</p>
      <hr style="border:none;border-top:2px solid #c9a04a;margin:24px 0"/>
      <p style="color:#0c0a08;font-weight:bold;margin:0">${brand.companyName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderCoiExpiryEmail(opts: {
  companyName: string;
  coverageType: string;
  policyNumber: string | null;
  insurer: string | null;
  expiryDate: string;
  daysRemaining: number;
}): { subject: string; text: string; html: string } {
  const urgency = opts.daysRemaining <= 7 ? "URGENT" : opts.daysRemaining <= 14 ? "Action needed" : opts.daysRemaining <= 30 ? "Reminder" : "Heads up";
  const coverageLabel = opts.coverageType.replace(/_/g, " ");
  const subject = `${urgency}: ${opts.companyName} insurance (${coverageLabel}) expires in ${opts.daysRemaining} days`;
  const headline = opts.daysRemaining > 30
    ? `A subcontractor's certificate of insurance is approaching expiry — please request an updated COI from ${opts.companyName} before it lapses.`
    : `A subcontractor's certificate of insurance is due to expire soon. An uninsured subcontractor should not be performing work.`;
  const text = [
    "Hi team,",
    "",
    headline,
    "",
    `  Subcontractor:  ${opts.companyName}`,
    `  Coverage:       ${coverageLabel}`,
    `  Insurer:        ${opts.insurer ?? "—"}`,
    `  Policy #:       ${opts.policyNumber ?? "—"}`,
    `  Expires:        ${opts.expiryDate}`,
    `  Days left:      ${opts.daysRemaining}`,
    "",
    "Request an updated certificate of insurance and upload it from the Subcontractors area in the admin portal.",
    "",
    `— ${brand.companyName}`,
  ].join("\n");
  const accent = opts.daysRemaining <= 7 ? "#a33" : "#c9a04a";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08">${escapeHtml(urgency)}: subcontractor insurance expiring</h2>
      <p>Hi team,</p>
      <p>${escapeHtml(headline)}</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid ${accent};margin:18px 0;border-radius:4px">
        <div><strong>Subcontractor:</strong> ${escapeHtml(opts.companyName)}</div>
        <div><strong>Coverage:</strong> ${escapeHtml(coverageLabel)}</div>
        <div><strong>Insurer:</strong> ${escapeHtml(opts.insurer ?? "—")}</div>
        <div><strong>Policy #:</strong> ${escapeHtml(opts.policyNumber ?? "—")}</div>
        <div><strong>Expires:</strong> ${escapeHtml(opts.expiryDate)}</div>
        <div><strong>Days remaining:</strong> ${opts.daysRemaining}</div>
      </div>
      <p>Request an updated certificate of insurance and upload it from the Subcontractors area in the admin portal.</p>
      <hr style="border:none;border-top:2px solid #c9a04a;margin:24px 0"/>
      <p style="color:#0c0a08;font-weight:bold;margin:0">${brand.companyName}</p>
    </div>
  `;
  return { subject, text, html };
}

/**
 * Render the admin alert for one or more high-risk self-edits by a single
 * officer, coalesced over a short digest window (default 15 min) so a
 * burst of edits collapses into a single push + email.
 *
 * `changes` is the per-field detail with the timestamp each edit was
 * detected. The template lists every row so admins can see exactly when
 * each field was touched without leaving the email. If only one row is
 * passed the layout degrades gracefully to the original single-change look.
 */
export function renderHighRiskProfileChangeEmail(opts: {
  officerName: string;
  officerEmail: string;
  changes: Array<{ label: string; whenIso: string }>;
  windowStartIso: string;
  windowEndIso: string;
  reviewUrl?: string;
}): { subject: string; text: string; html: string } {
  const labels = opts.changes.map((c) => c.label);
  const subject = `Officer self-edit alert: ${opts.officerName} updated ${
    labels.length === 1 ? labels[0] : `${labels.length} sensitive fields`
  }`;
  const fieldsList = opts.changes
    .map((c) => `  • ${c.label}  (at ${c.whenIso})`)
    .join("\n");
  const reviewLine = opts.reviewUrl ? `\nReview the change log: ${opts.reviewUrl}\n` : "";
  const windowLine = opts.windowStartIso === opts.windowEndIso
    ? `When:    ${opts.windowStartIso}`
    : `Window:  ${opts.windowStartIso} → ${opts.windowEndIso}`;
  const headline = labels.length === 1
    ? `Heads up — an officer just self-updated a high-risk profile field.`
    : `Heads up — an officer self-updated ${labels.length} high-risk profile fields in the last few minutes.`;
  const text = [
    headline,
    "",
    `Officer: ${opts.officerName} (${opts.officerEmail})`,
    windowLine,
    `Fields updated:`,
    fieldsList,
    reviewLine,
    `If this change wasn't expected (lost device, password sharing, payroll fraud, etc.), revoke the officer's sessions and confirm the update with them by phone before the next pay run.`,
    "",
    `— ${brand.companyName} · ${brand.appName}`,
  ].filter((l) => l !== undefined).join("\n");
  const fieldsHtml = `<ul style="margin:8px 0 0 0;padding-left:20px">${
    opts.changes
      .map((c) => `<li style="margin:4px 0">${escapeHtml(c.label)} <span style="color:#666;font-size:12px">(at ${escapeHtml(c.whenIso)})</span></li>`)
      .join("")
  }</ul>`;
  const reviewHtml = opts.reviewUrl
    ? `<p style="margin:18px 0"><a href="${escapeAttr(opts.reviewUrl)}" style="background:#0c0a08;color:#c9a04a;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:4px">Open change log</a></p>`
    : "";
  const windowHtml = opts.windowStartIso === opts.windowEndIso
    ? `<div><strong>When:</strong> ${escapeHtml(opts.windowStartIso)}</div>`
    : `<div><strong>Window:</strong> ${escapeHtml(opts.windowStartIso)} → ${escapeHtml(opts.windowEndIso)}</div>`;
  const intro = labels.length === 1
    ? `An officer just updated a high-risk profile field from the ${brand.appName} mobile app.`
    : `An officer updated ${labels.length} high-risk profile fields from the ${brand.appName} mobile app in the last few minutes (digest).`;
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08;margin-top:0">Officer self-edit alert</h2>
      <p>${intro}</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a04a;margin:18px 0;border-radius:4px;font-size:14px">
        <div><strong>Officer:</strong> ${escapeHtml(opts.officerName)} (${escapeHtml(opts.officerEmail)})</div>
        ${windowHtml}
        <div style="margin-top:8px"><strong>Fields updated:</strong></div>
        ${fieldsHtml}
      </div>
      ${reviewHtml}
      <p style="color:#a33">If this change wasn't expected (lost device, payroll fraud, etc.), revoke the officer's sessions and confirm the update by phone before the next pay run.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— ${brand.companyName} · ${brand.appName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderEmergencyAlertEmail(opts: {
  officerName: string;
  occurredAtIso: string;
  locationText?: string;
  message?: string;
  reviewUrl?: string;
}): { subject: string; text: string; html: string } {
  const subject = `🚨 EMERGENCY — ${opts.officerName} triggered a panic alert`;
  const locLine = opts.locationText ? `Location: ${opts.locationText}` : "Location: not available";
  const msgLine = opts.message ? `Message: ${opts.message}` : undefined;
  const reviewLine = opts.reviewUrl ? `\nOpen the incident: ${opts.reviewUrl}\n` : "";
  const text = [
    `An officer just pressed the emergency panic button. Verify their safety immediately.`,
    "",
    `Officer: ${opts.officerName}`,
    `When:    ${opts.occurredAtIso}`,
    locLine,
    msgLine,
    reviewLine,
    `— ${brand.companyName} · ${brand.appName}`,
  ].filter((l) => l !== undefined).join("\n");
  const locHtml = opts.locationText
    ? `<div><strong>Location:</strong> ${escapeHtml(opts.locationText)}</div>`
    : `<div><strong>Location:</strong> not available</div>`;
  const msgHtml = opts.message
    ? `<div style="margin-top:8px"><strong>Message:</strong> ${escapeHtml(opts.message)}</div>`
    : "";
  const reviewHtml = opts.reviewUrl
    ? `<p style="margin:18px 0"><a href="${escapeAttr(opts.reviewUrl)}" style="background:#a30000;color:#fff;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:4px">Open incident</a></p>`
    : "";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#a30000;margin-top:0">🚨 Emergency panic alert</h2>
      <p>An officer just pressed the emergency panic button. Verify their safety immediately.</p>
      <div style="background:#fbeaea;padding:14px 16px;border-left:3px solid #a30000;margin:18px 0;border-radius:4px;font-size:14px">
        <div><strong>Officer:</strong> ${escapeHtml(opts.officerName)}</div>
        <div><strong>When:</strong> ${escapeHtml(opts.occurredAtIso)}</div>
        ${locHtml}
        ${msgHtml}
      </div>
      ${reviewHtml}
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— ${brand.companyName} · ${brand.appName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderNewApplicationAdminEmail(opts: {
  applicantName: string;
  applicantEmail: string;
  applicantPhone?: string;
  reviewUrl?: string;
}): { subject: string; text: string; html: string } {
  const subject = `New application: ${opts.applicantName}`;
  const phoneLine = opts.applicantPhone ? `Phone: ${opts.applicantPhone}` : undefined;
  const reviewLine = opts.reviewUrl ? `\nReview the application: ${opts.reviewUrl}\n` : "";
  const text = [
    `A new employment application was just submitted.`,
    "",
    `Applicant: ${opts.applicantName}`,
    `Email:     ${opts.applicantEmail}`,
    phoneLine,
    reviewLine,
    `— ${brand.companyName} · ${brand.appName}`,
  ].filter((l) => l !== undefined).join("\n");
  const phoneHtml = opts.applicantPhone
    ? `<div><strong>Phone:</strong> ${escapeHtml(opts.applicantPhone)}</div>`
    : "";
  const reviewHtml = opts.reviewUrl
    ? `<p style="margin:18px 0"><a href="${escapeAttr(opts.reviewUrl)}" style="background:#0c0a08;color:#c9a04a;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:4px">Review application</a></p>`
    : "";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08;margin-top:0">New application received</h2>
      <p>A new employment application was just submitted.</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a04a;margin:18px 0;border-radius:4px;font-size:14px">
        <div><strong>Applicant:</strong> ${escapeHtml(opts.applicantName)}</div>
        <div><strong>Email:</strong> ${escapeHtml(opts.applicantEmail)}</div>
        ${phoneHtml}
      </div>
      ${reviewHtml}
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— ${brand.companyName} · ${brand.appName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderOnboardingCompletedAdminEmail(opts: {
  officerName: string;
  reviewUrl?: string;
}): { subject: string; text: string; html: string } {
  const subject = `Onboarding completed: ${opts.officerName}`;
  const reviewLine = opts.reviewUrl ? `\nReview onboarding: ${opts.reviewUrl}\n` : "";
  const text = [
    `${opts.officerName} just completed onboarding and is now active.`,
    reviewLine,
    `— ${brand.companyName} · ${brand.appName}`,
  ].filter((l) => l !== undefined).join("\n");
  const reviewHtml = opts.reviewUrl
    ? `<p style="margin:18px 0"><a href="${escapeAttr(opts.reviewUrl)}" style="background:#0c0a08;color:#c9a04a;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:4px">Review onboarding</a></p>`
    : "";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08;margin-top:0">Onboarding completed</h2>
      <p><strong>${escapeHtml(opts.officerName)}</strong> just completed onboarding and is now active.</p>
      ${reviewHtml}
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— ${brand.companyName} · ${brand.appName}</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderPaymentDiscrepancyEmail(opts: {
  officerName: string;
  officerEmail?: string;
  discrepancyType: string;
  payPeriod?: string;
  shiftDate?: string;
  expectedAmount?: string;
  receivedAmount?: string;
  description: string;
  reviewUrl?: string;
}): { subject: string; text: string; html: string } {
  const typeLabel = opts.discrepancyType.replace(/_/g, " ");
  const subject = `Payment discrepancy: ${opts.officerName} (${typeLabel})`;
  const rows: { label: string; value: string | undefined }[] = [
    { label: "Officer", value: opts.officerName },
    { label: "Email", value: opts.officerEmail },
    { label: "Type", value: typeLabel },
    { label: "Pay period", value: opts.payPeriod },
    { label: "Shift date", value: opts.shiftDate },
    { label: "Expected", value: opts.expectedAmount ? `$${opts.expectedAmount}` : undefined },
    { label: "Received", value: opts.receivedAmount ? `$${opts.receivedAmount}` : undefined },
  ].filter((r) => r.value !== undefined && r.value !== "");
  const reviewLine = opts.reviewUrl ? `\nReview in the Admin Portal: ${opts.reviewUrl}\n` : "";
  const text = [
    `A payment discrepancy was just submitted.`,
    "",
    ...rows.map((r) => `${r.label}: ${r.value}`),
    "",
    `Details:`,
    opts.description,
    reviewLine,
    `— ${brand.companyName} · ${brand.appName}`,
  ].join("\n");
  const rowsHtml = rows
    .map((r) => `<div><strong>${escapeHtml(r.label)}:</strong> ${escapeHtml(r.value!)}</div>`)
    .join("");
  const reviewHtml = opts.reviewUrl
    ? `<p style="margin:18px 0"><a href="${escapeAttr(opts.reviewUrl)}" style="background:#0c0a08;color:#c9a04a;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:4px">Open in Admin Portal</a></p>`
    : "";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08;margin-top:0">Payment discrepancy reported</h2>
      <p>A payment discrepancy was just submitted by an officer.</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a04a;margin:18px 0;border-radius:4px;font-size:14px">
        ${rowsHtml}
      </div>
      <div style="margin:18px 0">
        <strong>Details</strong>
        <p style="white-space:pre-wrap;margin:6px 0 0">${escapeHtml(opts.description)}</p>
      </div>
      ${reviewHtml}
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— ${brand.companyName} · ${brand.appName}</p>
    </div>
  `;
  return { subject, text, html };
}

// Inbound sales / sign-up lead from the public marketing site — sent to the
// sales inbox so the prospect gets followed up with the right tier in mind.
export function renderSalesLeadAdminEmail(opts: {
  companyName: string;
  contactName: string;
  email: string;
  phone?: string;
  tier?: string;
  officerCount?: number;
  message?: string;
  source?: string;
  reviewUrl?: string;
}): { subject: string; text: string; html: string } {
  const tierLabel = opts.tier ? opts.tier.replace(/_/g, " ") : undefined;
  const subject = `New sales lead: ${opts.companyName}${tierLabel ? ` (${tierLabel})` : ""}`;
  const rows: { label: string; value: string | undefined }[] = [
    { label: "Company", value: opts.companyName },
    { label: "Contact", value: opts.contactName },
    { label: "Email", value: opts.email },
    { label: "Phone", value: opts.phone },
    { label: "Interested tier", value: tierLabel },
    { label: "Officer count", value: opts.officerCount != null ? String(opts.officerCount) : undefined },
    { label: "Source", value: opts.source },
  ].filter((r) => r.value !== undefined && r.value !== "");
  const reviewLine = opts.reviewUrl ? `\nReview in the Admin Portal: ${opts.reviewUrl}\n` : "";
  const messageBlock = opts.message ? ["", "Message:", opts.message] : [];
  const text = [
    `A new sales lead was just submitted from the marketing site.`,
    "",
    ...rows.map((r) => `${r.label}: ${r.value}`),
    ...messageBlock,
    reviewLine,
    `— ${brand.companyName} · ${brand.appName}`,
  ].join("\n");
  const rowsHtml = rows
    .map((r) => `<div><strong>${escapeHtml(r.label)}:</strong> ${escapeHtml(r.value!)}</div>`)
    .join("");
  const messageHtml = opts.message
    ? `<div style="margin:18px 0"><strong>Message</strong><p style="white-space:pre-wrap;margin:6px 0 0">${escapeHtml(opts.message)}</p></div>`
    : "";
  const reviewHtml = opts.reviewUrl
    ? `<p style="margin:18px 0"><a href="${escapeAttr(opts.reviewUrl)}" style="background:#0c0a08;color:#c9a04a;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:4px">Open in Admin Portal</a></p>`
    : "";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08;margin-top:0">New sales lead</h2>
      <p>A prospect just requested access from the marketing site.</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a04a;margin:18px 0;border-radius:4px;font-size:14px">
        ${rowsHtml}
      </div>
      ${messageHtml}
      ${reviewHtml}
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— ${brand.companyName} · ${brand.appName}</p>
    </div>
  `;
  return { subject, text, html };
}

// Confirmation sent to the prospect so they know the request landed.
export function renderSalesLeadConfirmationEmail(opts: {
  contactName: string;
  tier?: string;
}): { subject: string; text: string; html: string } {
  const tierLabel = opts.tier ? opts.tier.replace(/_/g, " ") : undefined;
  const firstName = opts.contactName.trim().split(/\s+/)[0] || opts.contactName;
  const subject = `Thanks for your interest in ${brand.appName}`;
  const tierLine = tierLabel
    ? `We've noted you're interested in the ${tierLabel} plan and will tailor our reply accordingly.`
    : "";
  const text = [
    `Hi ${firstName},`,
    "",
    `Thanks for reaching out about ${brand.appName}. We've received your request and a member of our team will get back to you within one business day.`,
    ...(tierLine ? [tierLine] : []),
    "",
    `— ${brand.companyName} · ${brand.appName}`,
  ].join("\n");
  const tierHtml = tierLabel
    ? `<p>We've noted you're interested in the <strong>${escapeHtml(tierLabel)}</strong> plan and will tailor our reply accordingly.</p>`
    : "";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <h2 style="color:#0c0a08;margin-top:0">Thanks for reaching out</h2>
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Thanks for your interest in <strong>${escapeHtml(brand.appName)}</strong>. We've received your request and a member of our team will get back to you within one business day.</p>
      ${tierHtml}
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— ${brand.companyName} · ${brand.appName}</p>
    </div>
  `;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
