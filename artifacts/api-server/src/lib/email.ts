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
    `  Email:              ${opts.email}`,
    `  Temporary password: ${opts.tempPassword}`,
    "(You will be asked to set a new password on first login.)",
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
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a84c;margin:12px 0;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px">
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

export function renderRejectionEmail(opts: {
  firstName: string;
  reviewerNotes?: string | null;
}): { subject: string; text: string; html: string } {
  const subject = "Update on your Williams Council Security Group application";
  const notesBlock = opts.reviewerNotes && opts.reviewerNotes.trim().length > 0
    ? `\n\nNotes from our recruitment team:\n${opts.reviewerNotes.trim()}\n`
    : "";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    "Thank you for taking the time to apply to Williams Council Security Group.",
    "",
    "After careful consideration, we won't be moving forward with your application at this time.",
    "We genuinely appreciate your interest and the effort you put into applying, and we wish you the very best in your job search.",
    notesBlock,
    "You're welcome to apply again in the future as new positions open up.",
    "",
    "— Williams Council Security Group",
  ].join("\n");
  const notesHtml = opts.reviewerNotes && opts.reviewerNotes.trim().length > 0
    ? `<div style="background:#f6f1e1;padding:12px;border-left:3px solid #c9a84c;margin:16px 0;border-radius:4px">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#555;margin-bottom:6px">Notes from our team</div>
         <div style="white-space:pre-wrap">${escapeHtml(opts.reviewerNotes.trim())}</div>
       </div>`
    : "";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18">
      <h2 style="color:#080c18">Williams Council Security Group</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Thank you for taking the time to apply to Williams Council Security Group.</p>
      <p>After careful consideration, we won't be moving forward with your application at this time.
         We genuinely appreciate your interest and the effort you put into applying, and we wish you the very best in your job search.</p>
      ${notesHtml}
      <p style="color:#555">You're welcome to apply again in the future as new positions open up.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— Williams Council Security Group</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderApplicationReceivedEmail(opts: {
  firstName: string;
  reviewWindowDays?: number;
}): { subject: string; text: string; html: string } {
  const days = opts.reviewWindowDays ?? 5;
  const subject = "We've received your application — Williams Council Security Group";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    "Thanks for applying to Williams Council Security Group. This is a quick note to confirm we've received your application.",
    "",
    `Our recruitment team will review your submission within ${days} business days and be in touch with next steps. If we need anything else from you in the meantime, we'll reach out by email or phone.`,
    "",
    "There's no need to reply to this message.",
    "",
    "— Williams Council Security Group",
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18;background:#f0e6c8;padding:24px;border-radius:6px">
      <h2 style="color:#080c18;margin-top:0">Williams Council Security Group</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Thanks for applying to Williams Council Security Group. This is a quick note to confirm we've received your application.</p>
      <p>Our recruitment team will review your submission within <strong>${days} business days</strong> and be in touch with next steps. If we need anything else from you in the meantime, we'll reach out by email or phone.</p>
      <p style="color:#555">There's no need to reply to this message.</p>
      <hr style="border:none;border-top:2px solid #c9a84c;margin:24px 0"/>
      <p style="color:#080c18;font-weight:bold;margin:0">Williams Council Security Group</p>
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
  const subject = "We need a few more details on your application — Williams Council Security Group";
  const fieldsList = opts.fieldLabels.map((l) => `  • ${l}`).join("\n");
  const noteBlock = opts.note && opts.note.trim().length > 0
    ? `\n\nNote from our team:\n${opts.note.trim()}\n`
    : "";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    "Thanks for applying to Williams Council Security Group. To finish reviewing your application, we need a few more details from you:",
    "",
    fieldsList,
    noteBlock,
    "Please complete the missing items using the secure link below. The link expires in 14 days.",
    "",
    opts.amendUrl,
    "",
    "— Williams Council Security Group",
  ].join("\n");
  const fieldsHtml = `<ul style="margin:8px 0 0 0;padding-left:20px">${
    opts.fieldLabels.map((l) => `<li style="margin:4px 0">${escapeHtml(l)}</li>`).join("")
  }</ul>`;
  const noteHtml = opts.note && opts.note.trim().length > 0
    ? `<div style="background:#f6f1e1;padding:12px;border-left:3px solid #c9a84c;margin:16px 0;border-radius:4px">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#555;margin-bottom:6px">Note from our team</div>
         <div style="white-space:pre-wrap">${escapeHtml(opts.note.trim())}</div>
       </div>`
    : "";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18;background:#f0e6c8;padding:24px;border-radius:6px">
      <h2 style="color:#080c18;margin-top:0">Williams Council Security Group</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Thanks for applying. To finish reviewing your application, we need a few more details from you:</p>
      ${fieldsHtml}
      ${noteHtml}
      <p style="text-align:center;margin:24px 0">
        <a href="${escapeHtml(opts.amendUrl)}"
           style="display:inline-block;background:#080c18;color:#c9a84c;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">
          Complete missing details
        </a>
      </p>
      <p style="color:#555;font-size:12px">This secure link expires in 14 days. If the button doesn't work, paste this URL into your browser:<br/>
        <span style="word-break:break-all">${escapeHtml(opts.amendUrl)}</span>
      </p>
      <hr style="border:none;border-top:2px solid #c9a84c;margin:24px 0"/>
      <p style="color:#080c18;font-weight:bold;margin:0">Williams Council Security Group</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderPasswordResetEmail(opts: {
  firstName: string;
  resetUrl: string;
  expiresInMinutes: number;
}): { subject: string; text: string; html: string } {
  const subject = "Reset your Williams Council Security Group password";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    "We received a request to reset the password on your Williams Council Security Group account.",
    "",
    `Reset link (single use, expires in ${opts.expiresInMinutes} minutes):`,
    opts.resetUrl,
    "",
    "If you didn't request this, you can ignore this email — your password will stay the same.",
    "",
    "— Williams Council Security Group",
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18">
      <h2 style="color:#080c18">Reset your password</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>We received a request to reset the password on your Williams Council Security Group account.</p>
      <p style="margin:24px 0">
        <a href="${escapeAttr(opts.resetUrl)}"
           style="background:#c9a84c;color:#080c18;padding:12px 20px;text-decoration:none;font-weight:bold;border-radius:4px">
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
  const subject = `Your Williams Council Security Group password was just ${action}`;
  const hrContact = opts.hrContact ?? "hr@williamscouncilsecurity.com";
  const ipLine = opts.ip ? `Approximate location / IP: ${opts.ip}` : "Approximate location / IP: unknown";
  const uaLine = opts.userAgent ? `Device: ${opts.userAgent}` : "";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    `Your Williams Council Security Group password was just ${action}.`,
    "",
    `Time: ${opts.whenIso}`,
    ipLine,
    uaLine,
    "",
    `If this WAS you, no action is needed.`,
    `If this WASN'T you, contact HR immediately at ${hrContact} — your account may be compromised.`,
    "",
    "— Williams Council Security Group",
  ].filter((l) => l !== "").join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18">
      <h2 style="color:#080c18">Your password was just ${action}</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Your Williams Council Security Group password was just <strong>${action}</strong>.</p>
      <div style="background:#f6f1e1;padding:12px;border-left:3px solid #c9a84c;margin:16px 0;border-radius:4px;font-size:14px">
        <div><strong>Time:</strong> ${escapeHtml(opts.whenIso)}</div>
        <div><strong>Approximate location / IP:</strong> ${escapeHtml(opts.ip || "unknown")}</div>
        ${opts.userAgent ? `<div><strong>Device:</strong> ${escapeHtml(opts.userAgent)}</div>` : ""}
      </div>
      <p>If this <strong>was</strong> you, no action is needed.</p>
      <p style="color:#a33">If this <strong>wasn't</strong> you, contact HR immediately at
        <a href="mailto:${escapeAttr(hrContact)}">${escapeHtml(hrContact)}</a> — your account may be compromised.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— Williams Council Security Group</p>
    </div>
  `;
  return { subject, text, html };
}

export function renderInviteEmail(opts: {
  firstName: string;
  email: string;
  tempPassword: string;
  loginUrl: string;
}): { subject: string; text: string; html: string } {
  const subject = "Welcome to Williams Council Security Group — your login";
  const text = [
    `Hi ${opts.firstName},`,
    "",
    "Your Williams Council Security Group account is ready.",
    "",
    `Sign in at: ${opts.loginUrl}`,
    `Email:      ${opts.email}`,
    `Temporary password: ${opts.tempPassword}`,
    "",
    "Please sign in and change your password as soon as possible.",
    "",
    "— Williams Council Security Group",
  ].join("\n");
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18">
      <h2 style="color:#080c18">Welcome to Williams Council Security Group</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>Your account is ready. Use the credentials below to sign in for the first time, then change your password.</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a84c;margin:18px 0;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px">
        <div><strong>Email:</strong> ${escapeHtml(opts.email)}</div>
        <div><strong>Temporary password:</strong> ${escapeHtml(opts.tempPassword)}</div>
      </div>
      <p style="text-align:center;margin:24px 0">
        <a href="${escapeAttr(opts.loginUrl)}"
           style="display:inline-block;background:#080c18;color:#c9a84c;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">
          Sign in
        </a>
      </p>
      <p style="color:#555;font-size:12px">If the button doesn't work, paste this URL into your browser:<br/>
        <span style="word-break:break-all">${escapeHtml(opts.loginUrl)}</span>
      </p>
      <hr style="border:none;border-top:2px solid #c9a84c;margin:24px 0"/>
      <p style="color:#080c18;font-weight:bold;margin:0">Williams Council Security Group</p>
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
    "— Williams Council Security Group",
  ].join("\n");
  const accent = opts.daysRemaining <= 7 ? "#a33" : "#c9a84c";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18">
      <h2 style="color:#080c18">${escapeHtml(urgency)}: training renewal needed</h2>
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
      <hr style="border:none;border-top:2px solid #c9a84c;margin:24px 0"/>
      <p style="color:#080c18;font-weight:bold;margin:0">Williams Council Security Group</p>
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
    "— Williams Council Security Group",
  ].join("\n");
  const accent = opts.daysRemaining <= 7 ? "#a33" : "#c9a84c";
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18">
      <h2 style="color:#080c18">${escapeHtml(urgency)}: license renewal needed</h2>
      <p>Hi ${escapeHtml(opts.firstName)},</p>
      <p>${escapeHtml(headline)}</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid ${accent};margin:18px 0;border-radius:4px">
        <div><strong>License:</strong> ${escapeHtml(opts.licenseType)} (${escapeHtml(opts.licenseNumber)})</div>
        <div><strong>Expires:</strong> ${escapeHtml(opts.expiryDate)}</div>
        <div><strong>Days remaining:</strong> ${opts.daysRemaining}</div>
      </div>
      <p>Please renew before the expiry date. An expired license means you cannot clock in or be assigned to qualifying shifts.</p>
      <p style="color:#555;font-size:13px">If you have already renewed, please send a copy of the new license to HR so we can update your record.</p>
      <hr style="border:none;border-top:2px solid #c9a84c;margin:24px 0"/>
      <p style="color:#080c18;font-weight:bold;margin:0">Williams Council Security Group</p>
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
    "— Williams Council Security Group · SecureOps",
  ].filter((l) => l !== undefined).join("\n");
  const fieldsHtml = `<ul style="margin:8px 0 0 0;padding-left:20px">${
    opts.changes
      .map((c) => `<li style="margin:4px 0">${escapeHtml(c.label)} <span style="color:#666;font-size:12px">(at ${escapeHtml(c.whenIso)})</span></li>`)
      .join("")
  }</ul>`;
  const reviewHtml = opts.reviewUrl
    ? `<p style="margin:18px 0"><a href="${escapeAttr(opts.reviewUrl)}" style="background:#080c18;color:#c9a84c;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:4px">Open change log</a></p>`
    : "";
  const windowHtml = opts.windowStartIso === opts.windowEndIso
    ? `<div><strong>When:</strong> ${escapeHtml(opts.windowStartIso)}</div>`
    : `<div><strong>Window:</strong> ${escapeHtml(opts.windowStartIso)} → ${escapeHtml(opts.windowEndIso)}</div>`;
  const intro = labels.length === 1
    ? `An officer just updated a high-risk profile field from the SecureOps mobile app.`
    : `An officer updated ${labels.length} high-risk profile fields from the SecureOps mobile app in the last few minutes (digest).`;
  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#080c18">
      <h2 style="color:#080c18;margin-top:0">Officer self-edit alert</h2>
      <p>${intro}</p>
      <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a84c;margin:18px 0;border-radius:4px;font-size:14px">
        <div><strong>Officer:</strong> ${escapeHtml(opts.officerName)} (${escapeHtml(opts.officerEmail)})</div>
        ${windowHtml}
        <div style="margin-top:8px"><strong>Fields updated:</strong></div>
        ${fieldsHtml}
      </div>
      ${reviewHtml}
      <p style="color:#a33">If this change wasn't expected (lost device, payroll fraud, etc.), revoke the officer's sessions and confirm the update by phone before the next pay run.</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:24px 0"/>
      <p style="color:#555;font-size:12px">— Williams Council Security Group · SecureOps</p>
    </div>
  `;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
