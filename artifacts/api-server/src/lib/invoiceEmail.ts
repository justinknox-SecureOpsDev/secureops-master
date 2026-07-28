import { createHash } from "node:crypto";
import { brand } from "./brandConfig";

/**
 * The invoice email an admin reviews before sending, and the one the client
 * actually receives, are built here — once — so a preview can never show
 * something different from what goes out.
 *
 * Anything that changes the wording, the totals, or the attached PDF must be
 * changed in this module rather than at a call site, or the preview and the
 * sent mail drift apart and the review step stops being a real safeguard.
 */

export type InvoiceEmailLineItem = {
  description: string;
  level?: number | null;
  hours?: number | null;
  rate?: number | null;
  amount: number;
};

export type InvoiceEmailRow = {
  invoiceNumber: string;
  clientName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string | null;
  subtotal: string | number | null;
  taxAmount: string | number | null;
  totalAmount: string | number | null;
  processingFeeRate: string | number | null;
  processingFeeAmount: string | number | null;
  lineItems?: InvoiceEmailLineItem[] | null;
  // Not in the email body, but printed on the attached PDF — so they belong in
  // the digest, or the attachment could change after the admin approved it.
  siteName?: string | null;
  clientAddress?: string | null;
  notes?: string | null;
};

export type InvoiceEmailContent = {
  subject: string;
  text: string;
  html: string;
};

export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function usd(v: string | number | null | undefined): string {
  return parseFloat(String(v ?? "0")).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/**
 * Render the client-facing invoice email. Pure: given the same invoice row and
 * brand settings it always produces the same subject/body, which is what makes
 * the preview digest meaningful.
 */
export function buildInvoiceEmailContent(row: InvoiceEmailRow): InvoiceEmailContent {
  const totalDisplay = usd(row.totalAmount);
  const period = `${row.periodStart} to ${row.periodEnd}`;
  const feeAmt = parseFloat(String(row.processingFeeAmount ?? "0"));
  const feeRt = parseFloat(String(row.processingFeeRate ?? "0"));
  const feeDisplay = feeAmt > 0 ? usd(feeAmt) : null;
  const feeLabel = `Processing fee${feeRt > 0 ? ` (${feeRt}%)` : ""}`;

  const subject = `Invoice ${row.invoiceNumber} — ${brand.companyName}`;

  const text = [
    `Dear ${row.clientName ?? "Client"},`,
    "",
    `Please find attached invoice ${row.invoiceNumber} for security services provided during ${period}.`,
    "",
    `${feeDisplay ? `${feeLabel}: ${feeDisplay}\n` : ""}Invoice total: ${totalDisplay}${row.dueDate ? `\nDue date:      ${row.dueDate}` : ""}`,
    "",
    `Please reference the invoice number on your payment. For questions, contact ${brand.billingEmail}.`,
    "",
    `— ${brand.companyName}${brand.companyLicense ? ` · ${brand.companyLicense}` : ""}`,
  ].join("\n");

  const html = `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:${brand.colorNavy}">
        <div style="background:${brand.colorNavy};padding:20px 24px;border-radius:4px 4px 0 0">
          <h2 style="color:${brand.colorGold};margin:0;font-size:18px">${escHtml(brand.companyName)}</h2>
          <p style="color:${brand.colorCream};margin:4px 0 0;font-size:12px">${escHtml(brand.tagline)}</p>
          ${brand.companyLicense ? `<p style="color:${brand.colorCream};margin:2px 0 0;font-size:11px">${escHtml(brand.companyLicense)}</p>` : ""}
        </div>
        <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 4px 4px">
          <p>Dear ${escHtml(row.clientName ?? "Client")},</p>
          <p>Please find attached invoice <strong>${escHtml(row.invoiceNumber)}</strong> for security services provided during <strong>${escHtml(period)}</strong>.</p>
          <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid ${brand.colorGold};margin:18px 0;border-radius:4px">
            ${feeDisplay ? `<div><strong>${escHtml(feeLabel)}:</strong> ${escHtml(feeDisplay)}</div>` : ""}
            <div><strong>Invoice total:</strong> ${escHtml(totalDisplay)}</div>
            ${row.dueDate ? `<div><strong>Due date:</strong> ${escHtml(row.dueDate)}</div>` : ""}
            <div><strong>Invoice #:</strong> ${escHtml(row.invoiceNumber)}</div>
          </div>
          <p style="color:#555;font-size:13px">Please reference the invoice number on your payment. For questions, contact <a href="mailto:${escHtml(brand.billingEmail)}">${escHtml(brand.billingEmail)}</a>.</p>
          <hr style="border:none;border-top:2px solid ${brand.colorGold};margin:20px 0"/>
          <p style="color:${brand.colorNavy};font-weight:bold;margin:0;font-size:13px">${escHtml(brand.companyName)}${brand.companyLicense ? ` · ${escHtml(brand.companyLicense)}` : ""}</p>
        </div>
      </div>
    `;

  return { subject, text, html };
}

/**
 * Fingerprint of everything the admin is asked to approve: the email wording,
 * the money, and the billed lines that end up in the attached PDF.
 *
 * The recipient address is deliberately NOT part of this. It is an editable
 * field inside the confirmation dialog, so changing it is itself a deliberate
 * admin action taken while looking at the preview — re-fetching a preview on
 * every keystroke would be pointless churn.
 */
export function invoiceEmailDigest(row: InvoiceEmailRow): string {
  const { subject, text } = buildInvoiceEmailContent(row);
  const material = JSON.stringify({
    subject,
    text,
    // Everything the client can see. The body covers the wording; these cover
    // the attached PDF, which the email body does not fully determine.
    invoiceNumber: row.invoiceNumber,
    clientName: row.clientName ?? "",
    siteName: row.siteName ?? "",
    clientAddress: row.clientAddress ?? "",
    notes: row.notes ?? "",
    periodStart: String(row.periodStart ?? ""),
    periodEnd: String(row.periodEnd ?? ""),
    dueDate: String(row.dueDate ?? ""),
    subtotal: String(row.subtotal ?? ""),
    tax: String(row.taxAmount ?? ""),
    feeRate: String(row.processingFeeRate ?? ""),
    feeAmount: String(row.processingFeeAmount ?? ""),
    total: String(row.totalAmount ?? ""),
    lines: (row.lineItems ?? []).map((li) => [
      li.description,
      li.level ?? null,
      li.hours ?? null,
      li.rate ?? null,
      li.amount,
    ]),
  });
  return createHash("sha256").update(material).digest("hex");
}
