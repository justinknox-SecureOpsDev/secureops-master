import PDFDocument from "pdfkit";
import type { Readable } from "node:stream";
import { brand } from "./brandConfig";
import { drawBrandHeader } from "./pdfHeader";

const MUTED = "#666666";
const TEXT  = "#1a1a1a";
const LIGHT = "#f7f7f7";

export type InvoicePdfInput = {
  invoiceNumber: string;
  clientName: string | null;
  clientEmail: string | null;
  clientAddress: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  dueDate: string | null;
  createdAt: Date | string;
  lineItems: Array<{
    description: string;
    level?: number | null;
    hours?: number | null;
    rate?: number | null;
    amount: number;
  }> | null;
  subtotal: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  notes: string | null;
  processingFeeRate?: string | number | null;
  processingFeeAmount?: string | number | null;
  /**
   * When set, a notice callout is rendered on the PDF warning the client that
   * processing fees may have been updated since this invoice was generated.
   * Use this when serving a sent/paid invoice whose processingFeeAmount is
   * stale (NULL) relative to the site's current processing-fee setting.
   */
  staleFeeNote?: string | null;
};

export type InvoicePdfPayload = {
  filename: string;
  stream: Readable;
  buffer: () => Promise<Buffer>;
};

const fmtDate = (d: string | Date | null): string => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
};

const fmtUsd = (n: string | number | null): string => {
  const v = parseFloat(String(n ?? "0")) || 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

/**
 * Licence-level labels. Kept in sync with the admin invoice board so the PDF a
 * client receives reads the same as the board an admin approved it from.
 * Unknown levels fall back to "L<n>" rather than rendering blank.
 */
const LEVEL_LABELS: Record<number, string> = {
  1: "Support Staff",
  2: "Unarmed",
  3: "Armed",
  4: "L4/PPO",
};

const levelLabel = (level: number | null | undefined): string =>
  level == null ? "Unspecified" : LEVEL_LABELS[level] ?? `L${level}`;

type LevelTotal = { level: number | null; hours: number; amount: number };

/**
 * Roll the line items up per licence level. Items are grouped per officer (and
 * rate/holiday), so an invoice usually carries several rows at the same level;
 * this collapses them into "how many armed vs unarmed hours were billed".
 */
function totalsByLevel(
  items: NonNullable<InvoicePdfInput["lineItems"]>,
): LevelTotal[] {
  const acc = new Map<number | null, LevelTotal>();
  for (const it of items) {
    const key = it.level ?? null;
    const cur = acc.get(key) ?? { level: key, hours: 0, amount: 0 };
    cur.hours += it.hours ?? 0;
    cur.amount += it.amount ?? 0;
    acc.set(key, cur);
  }
  return Array.from(acc.values()).sort(
    (a, b) => (a.level ?? Number.MAX_SAFE_INTEGER) - (b.level ?? Number.MAX_SAFE_INTEGER),
  );
}

function sectionHeader(doc: PDFKit.PDFDocument, label: string): void {
  doc.fillColor(brand.colorNavy).font("Helvetica-Bold").fontSize(9)
    .text(label.toUpperCase(), 56, doc.y, { characterSpacing: 0.5 });
  const lineY = doc.y + 2;
  doc.moveTo(56, lineY).lineTo(doc.page.width - 56, lineY)
    .strokeColor(brand.colorGold).lineWidth(0.7).stroke();
  doc.moveDown(0.6);
}

/**
 * Attachment name for an invoice PDF. Exported so the send-preview can show the
 * admin the real filename without paying to render the document.
 */
export function invoicePdfFilename(invoiceNumber: string): string {
  const safeNum = invoiceNumber.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const safeShort = brand.shortName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  return `${safeShort}-invoice-${safeNum}.pdf`;
}

export function buildInvoicePdf(inv: InvoicePdfInput): InvoicePdfPayload {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: {
      Title: `Invoice ${inv.invoiceNumber}`,
      Author: brand.companyName,
      Subject: `Invoice ${inv.invoiceNumber} — ${inv.clientName ?? "Client"}`,
      CreationDate: new Date(),
    },
  });

  const W = doc.page.width;

  // ── Header band — logo badge above the company name ───────────────────────
  const top = drawBrandHeader(doc, `${brand.tagline}  ·  Invoice`);

  doc.y = top;

  // ── Invoice header: number + dates ────────────────────────────────────────
  const colL = 56;
  const colR = W / 2 + 20;

  // Left: Bill To
  let y = top + 6;
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8)
    .text("BILL TO", colL, y, { characterSpacing: 0.8 });
  y += 13;
  doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(11)
    .text(inv.clientName ?? "—", colL, y);
  y = doc.y + 2;
  if (inv.clientAddress) {
    doc.fillColor(TEXT).font("Helvetica").fontSize(9)
      .text(inv.clientAddress, colL, y, { width: 220 });
    y = doc.y + 2;
  }
  if (inv.clientEmail) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(9)
      .text(inv.clientEmail, colL, y);
    y = doc.y + 2;
  }
  if (inv.siteName) {
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9)
      .text(`Site: ${inv.siteName}`, colL, y);
    y = doc.y + 2;
  }

  // Right: invoice meta box
  const boxY = top + 6;
  const boxW = 200;
  const boxX = W - 56 - boxW;
  doc.rect(boxX, boxY, boxW, 96).fill(LIGHT);
  doc.moveTo(boxX, boxY).lineTo(boxX + boxW, boxY).strokeColor(brand.colorGold).lineWidth(1.5).stroke();

  const metaRows: Array<[string, string]> = [
    ["Invoice #",   inv.invoiceNumber],
    ["Issued",      fmtDate(inv.createdAt)],
    ["Service period", `${fmtDate(inv.periodStart)} – ${fmtDate(inv.periodEnd)}`],
    ["Due",         fmtDate(inv.dueDate)],
  ];
  let metaY = boxY + 10;
  for (const [k, v] of metaRows) {
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7.5)
      .text(k.toUpperCase(), boxX + 10, metaY, { width: 74 });
    doc.fillColor(TEXT).font("Helvetica").fontSize(8.5)
      .text(v, boxX + 86, metaY, { width: boxW - 96 });
    metaY += 18;
  }

  doc.y = Math.max(y + 12, boxY + 96 + 12);

  // ── Line items ────────────────────────────────────────────────────────────
  sectionHeader(doc, "Services Rendered");

  // Table header row
  const th = doc.y;
  doc.rect(56, th - 2, W - 112, 16).fill("#eef0f3");
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
  doc.text("Officer",  66, th, { width: 165 });
  // Wide enough for the longest label ("Support Staff") on one line.
    doc.text("Level",   235, th, { width: 62, align: "center" });
  doc.text("Hours",   300, th, { width: 60, align: "right" });
  doc.text("Rate",    366, th, { width: 65, align: "right" });
  doc.text("Amount",  436, th, { width: 100, align: "right" });
  doc.y = th + 18;

  // Helper to draw the column-header row on whatever page the cursor is on.
  function drawTableHeader() {
    const th = doc.y;
    doc.rect(56, th - 2, W - 112, 16).fill("#eef0f3");
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    doc.text("Officer",  66, th, { width: 165 });
    // Wide enough for the longest label ("Support Staff") on one line.
    doc.text("Level",   235, th, { width: 62, align: "center" });
    doc.text("Hours",   300, th, { width: 60, align: "right" });
    doc.text("Rate",    366, th, { width: 65, align: "right" });
    doc.text("Amount",  436, th, { width: 100, align: "right" });
    doc.y = th + 18;
  }

  const items = inv.lineItems ?? [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let rowY = doc.y;
    if (rowY > doc.page.height - 100) {
      doc.addPage();
      drawTableHeader();
      rowY = doc.y;
    }
    if (i % 2 === 1) doc.rect(56, rowY - 1, W - 112, 16).fill("#fafafa");
    doc.fillColor(TEXT).font("Helvetica").fontSize(9);
    doc.text(item.description,  66, rowY, { width: 165, lineBreak: false });
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5);
    doc.text(
      item.level != null ? levelLabel(item.level) : "—",
      235, rowY, { width: 62, align: "center", lineBreak: false },
    );
    doc.fillColor(TEXT).font("Helvetica").fontSize(9);
    doc.text(
      item.hours != null ? item.hours.toFixed(2) : "—",
      300, rowY, { width: 60, align: "right" },
    );
    doc.text(
      item.rate != null ? fmtUsd(item.rate) : "—",
      366, rowY, { width: 65, align: "right" },
    );
    doc.text(fmtUsd(item.amount), 436, rowY, { width: 100, align: "right" });
    doc.y = rowY + 16;
  }

  doc.moveDown(0.4);
  doc.moveTo(56, doc.y).lineTo(W - 56, doc.y).strokeColor("#ddd").lineWidth(0.5).stroke();
  doc.moveDown(0.4);

  // ── Hours by licence level ────────────────────────────────────────────────
  // Rolls the per-officer rows up so the client can see the armed/unarmed split
  // at a glance. Drawn on the left so it sits beside the right-aligned totals.
  const levelTotals = totalsByLevel(items);
  let levelBlockEndY = doc.y;
  if (levelTotals.length > 0) {
    // Keep the heading with its rows: if the whole block cannot fit above the
    // footer margin, start it on a fresh page rather than orphaning the header.
    const blockHeight = 14 + levelTotals.length * 12 + 14;
    if (doc.y + blockHeight > doc.page.height - 90) doc.addPage();

    const blockTop = doc.y;
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8)
      .text("HOURS BY LICENCE LEVEL", 56, blockTop, { width: 220 });
    let ly = blockTop + 13;

    let allHours = 0;
    for (const lt of levelTotals) {
      allHours += lt.hours;
      doc.fillColor(TEXT).font("Helvetica").fontSize(8.5)
        .text(levelLabel(lt.level), 56, ly, { width: 110, lineBreak: false });
      doc.fillColor(TEXT).font("Helvetica").fontSize(8.5)
        .text(`${lt.hours.toFixed(2)} hrs`, 168, ly, { width: 55, align: "right" });
      doc.fillColor(MUTED).font("Helvetica").fontSize(8.5)
        .text(fmtUsd(lt.amount), 227, ly, { width: 70, align: "right" });
      ly += 12;
    }

    doc.moveTo(56, ly + 1).lineTo(297, ly + 1).strokeColor("#ddd").lineWidth(0.5).stroke();
    ly += 4;
    doc.fillColor(brand.colorNavy).font("Helvetica-Bold").fontSize(8.5)
      .text("Total hours", 56, ly, { width: 110, lineBreak: false });
    doc.fillColor(brand.colorNavy).font("Helvetica-Bold").fontSize(8.5)
      .text(`${allHours.toFixed(2)} hrs`, 168, ly, { width: 55, align: "right" });
    levelBlockEndY = ly + 14;

    // Totals are drawn from doc.y on the right-hand side; rewind to the top of
    // this block so the two sit side by side instead of stacking.
    doc.y = blockTop;
  }

  // ── Totals block ──────────────────────────────────────────────────────────
  const totX = W - 56 - 200;
  const addTotalRow = (label: string, value: string, bold = false) => {
    const ry = doc.y;
    doc.fillColor(bold ? brand.colorNavy : MUTED)
      .font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 10 : 9)
      .text(label, totX, ry, { width: 120, align: "right" });
    doc.fillColor(bold ? brand.colorNavy : TEXT)
      .font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 10 : 9)
      .text(value, totX + 124, ry, { width: 76, align: "right" });
    doc.y = ry + (bold ? 14 : 13);
  };

  const subtotal = parseFloat(String(inv.subtotal ?? "0")) || 0;
  const tax = parseFloat(String(inv.taxAmount ?? "0")) || 0;
  const total = parseFloat(String(inv.totalAmount ?? "0")) || 0;

  const fee = parseFloat(String(inv.processingFeeAmount ?? "0")) || 0;
  const feeRateVal = parseFloat(String(inv.processingFeeRate ?? "0")) || 0;

  addTotalRow("Subtotal", fmtUsd(subtotal));
  if (fee > 0) addTotalRow(`Processing fee (${feeRateVal.toFixed(2)}%)`, fmtUsd(fee));
  doc.moveDown(0.3);
  const totalBoxY = doc.y - 4;
  doc.rect(totX - 10, totalBoxY, 210, 20).fill(brand.colorNavy);
  doc.y = totalBoxY + 4;
  doc.fillColor(brand.colorCream).font("Helvetica-Bold").fontSize(9)
    .text("TOTAL DUE", totX, doc.y, { width: 120, align: "right" });
  doc.fillColor(brand.colorGold).font("Helvetica-Bold").fontSize(11)
    .text(fmtUsd(total), totX + 124, totalBoxY + 4, { width: 76, align: "right" });
  doc.y = totalBoxY + 24;

  // The licence-level block was drawn to the left of the totals from the same
  // starting Y. Drop below whichever column is taller so Notes never lands on
  // top of the breakdown.
  doc.y = Math.max(doc.y, levelBlockEndY);

  // ── Notes ────────────────────────────────────────────────────────────────
  if (inv.notes && inv.notes.trim()) {
    doc.moveDown(1);
    sectionHeader(doc, "Notes");
    doc.fillColor(TEXT).font("Helvetica").fontSize(9)
      .text(inv.notes.trim(), 56, doc.y, { width: W - 112, lineGap: 2 });
  }

  // ── Stale-fee notice (shown when invoice was sent before fees were enabled) ──
  if (inv.staleFeeNote && inv.staleFeeNote.trim()) {
    doc.moveDown(1);
    if (doc.y > doc.page.height - 80) doc.addPage();
    const noticeY = doc.y;
    const noticeH = 44;
    // Amber/gold tinted background
    doc.rect(56, noticeY, W - 112, noticeH).fill("#fff8e6");
    doc.moveTo(56, noticeY).lineTo(56 + 4, noticeY)
      .lineTo(56 + 4, noticeY + noticeH).lineTo(56, noticeY + noticeH)
      .fillColor("#c9a04a");
    doc.rect(56, noticeY, 4, noticeH).fill("#c9a04a");
    doc.fillColor("#7a5c00").font("Helvetica-Bold").fontSize(8)
      .text("NOTICE", 68, noticeY + 8, { width: W - 136, characterSpacing: 0.5 });
    doc.fillColor("#5a4000").font("Helvetica").fontSize(8)
      .text(inv.staleFeeNote.trim(), 68, noticeY + 20, { width: W - 136, lineBreak: false });
    doc.y = noticeY + noticeH + 8;
  }

  // ── Payment footer ────────────────────────────────────────────────────────
  doc.moveDown(1.5);
  if (doc.y > doc.page.height - 90) doc.addPage();
  doc.rect(56, doc.y, W - 112, 48).fill(brand.colorCream);
  const ftY = doc.y + 10;
  doc.fillColor(brand.colorNavy).font("Helvetica-Bold").fontSize(9)
    .text("Payment information", 66, ftY);
  doc.fillColor(MUTED).font("Helvetica").fontSize(8)
    .text(
      `Please reference the invoice number on payment. For questions, contact ${brand.billingEmail}.`,
      66, ftY + 13, { width: W - 132 },
    );
  doc.y += 58;

  // Page footer
  const pfY = doc.page.height - 36;
  doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(
    `Generated ${new Date().toLocaleString()}  ·  ${brand.companyName}${brand.companyLicense ? `  ·  ${brand.companyLicense}` : ""}  ·  Invoice ${inv.invoiceNumber}`,
    56, pfY, { width: W - 112, align: "center", lineBreak: false },
  );

  doc.end();

  const filename = invoicePdfFilename(inv.invoiceNumber);

  const stream = doc as unknown as Readable;

  const buffer = (): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });

  return { filename, stream, buffer };
}
