import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger";

/**
 * Lightweight, env-gated SMTP sender.
 *
 * Required env to enable sending:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * If any are missing, `sendEmail` returns false and logs a single info line —
 * callers fall back to surfacing the link/credentials in the API response so
 * the admin can share them manually.
 */

let cached: Transporter | null = null;
let warned = false;

function getTransport(): Transporter | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    if (!warned) {
      logger.info("SMTP not configured — emails will not be sent (admins must share links manually).");
      warned = true;
    }
    return null;
  }
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return cached;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const t = getTransport();
  if (!t) return false;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER!;
  try {
    await t.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    return true;
  } catch (err) {
    logger.error({ err, to: msg.to }, "Failed to send email");
    return false;
  }
}

export function renderOnboardingEmail(opts: {
  firstName: string;
  onboardingUrl: string;
  email: string;
  tempPassword: string;
}): { subject: string; text: string; html: string } {
  const subject = "Welcome to Williams Council Security Group — complete your onboarding";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    "Your application has been approved. To finish onboarding, please complete the secure form below.",
    "",
    `Onboarding link (single use, expires in 14 days): ${opts.onboardingUrl}`,
    "",
    "After onboarding you can sign in to the SecureOps app with:",
    `  Email:    ${opts.email}`,
    `  Password: ${opts.tempPassword}`,
    "(You will be asked to change this password on first login.)",
    "",
    "— Williams Council Security Group",
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18">
      <h2 style="color:#080c18">Welcome to Williams Council Security Group</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Your application has been approved. To finish onboarding, please complete the secure form below.</p>
      <p style="margin:24px 0">
        <a href="${escapeAttr(opts.onboardingUrl)}"
           style="background:#c9a84c;color:#080c18;padding:12px 20px;text-decoration:none;font-weight:bold;border-radius:4px">
          Complete onboarding
        </a>
      </p>
      <p style="color:#555">This link is single use and expires in 14 days.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p>After onboarding, sign in to the SecureOps app with:</p>
      <pre style="background:#f6f1e1;padding:12px;border-radius:4px">Email:    ${escapeHtml(opts.email)}
Password: ${escapeHtml(opts.tempPassword)}</pre>
      <p style="color:#555;font-size:12px">You will be asked to change this password on first login.</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderResendOnboardingEmail(opts: {
  firstName: string;
  onboardingUrl: string;
}): { subject: string; text: string; html: string } {
  const subject = "Your Williams Council Security Group onboarding link";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    "Here is a fresh link to complete your onboarding (single use, expires in 14 days):",
    "",
    opts.onboardingUrl,
    "",
    "— Williams Council Security Group",
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18">
      <h2 style="color:#080c18">Williams Council Security Group</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Here is a fresh link to complete your onboarding.</p>
      <p style="margin:24px 0">
        <a href="${escapeAttr(opts.onboardingUrl)}"
           style="background:#c9a84c;color:#080c18;padding:12px 20px;text-decoration:none;font-weight:bold;border-radius:4px">
          Complete onboarding
        </a>
      </p>
      <p style="color:#555">This link is single use and expires in 14 days.</p>
    </div>
  `;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
