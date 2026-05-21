import PDFDocument from "pdfkit";
import type { Readable } from "node:stream";

const NAVY  = "#080c18";
const GOLD  = "#c9a84c";
const CREAM = "#f0e6c8";
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
    hours?: number | null;
    rate?: number | null;
    amount: number;
  }> | null;
  subtotal: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  notes: string | null;
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

function sectionHeader(doc: PDFKit.PDFDocument, label: string): void {
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(9)
    .text(label.toUpperCase(), 56, doc.y, { characterSpacing: 0.5 });
  const lineY = doc.y + 2;
  doc.moveTo(56, lineY).lineTo(doc.page.width - 56, lineY)
    .strokeColor(GOLD).lineWidth(0.7).stroke();
  doc.moveDown(0.6);
}

export function buildInvoicePdf(inv: InvoicePdfInput): InvoicePdfPayload {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: {
      Title: `Invoice ${inv.invoiceNumber}`,
      Author: "Williams Council Security Group",
      Subject: `Invoice ${inv.invoiceNumber} — ${inv.clientName ?? "Client"}`,
      CreationDate: new Date(),
    },
  });

  const W = doc.page.width;

  // ── Header band ──────────────────────────────────────────────────────────
  doc.rect(0, 0, W, 80).fill(NAVY);
  doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(20)
    .text("Williams Council Security Group", 56, 22, { characterSpacing: 0.2 });
  doc.fillColor(CREAM).font("Helvetica").fontSize(9)
    .text("Professional Security Services  ·  Invoice", 56, 50);
  doc.rect(0, 80, W, 3).fill(GOLD);

  doc.y = 100;

  // ── Invoice header: number + dates ────────────────────────────────────────
  const colL = 56;
  const colR = W / 2 + 20;

  // Left: Bill To
  let y = 106;
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
  const boxY = 100;
  const boxW = 200;
  const boxX = W - 56 - boxW;
  doc.rect(boxX, boxY, boxW, 96).fill(LIGHT);
  doc.moveTo(boxX, boxY).lineTo(boxX + boxW, boxY).strokeColor(GOLD).lineWidth(1.5).stroke();

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
  doc.text("Description",  66, th, { width: 260 });
  doc.text("Hours",        330, th, { width: 55, align: "right" });
  doc.text("Rate",         390, th, { width: 60, align: "right" });
  doc.text("Amount",       454, th, { width: 80, align: "right" });
  doc.y = th + 18;

  const items = inv.lineItems ?? [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rowY = doc.y;
    if (rowY > doc.page.height - 100) doc.addPage();
    if (i % 2 === 1) doc.rect(56, rowY - 1, W - 112, 16).fill("#fafafa");
    doc.fillColor(TEXT).font("Helvetica").fontSize(9);
    doc.text(item.description,  66, rowY, { width: 258, lineBreak: false });
    doc.text(
      item.hours != null ? item.hours.toFixed(2) : "—",
      330, rowY, { width: 55, align: "right" },
    );
    doc.text(
      item.rate != null ? fmtUsd(item.rate) : "—",
      390, rowY, { width: 60, align: "right" },
    );
    doc.text(fmtUsd(item.amount), 454, rowY, { width: 80, align: "right" });
    doc.y = rowY + 16;
  }

  doc.moveDown(0.4);
  doc.moveTo(56, doc.y).lineTo(W - 56, doc.y).strokeColor("#ddd").lineWidth(0.5).stroke();
  doc.moveDown(0.4);

  // ── Totals block ──────────────────────────────────────────────────────────
  const totX = W - 56 - 200;
  const addTotalRow = (label: string, value: string, bold = false) => {
    const ry = doc.y;
    doc.fillColor(bold ? NAVY : MUTED)
      .font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 10 : 9)
      .text(label, totX, ry, { width: 120, align: "right" });
    doc.fillColor(bold ? NAVY : TEXT)
      .font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 10 : 9)
      .text(value, totX + 124, ry, { width: 76, align: "right" });
    doc.y = ry + (bold ? 14 : 13);
  };

  const subtotal = parseFloat(String(inv.subtotal ?? "0")) || 0;
  const tax = parseFloat(String(inv.taxAmount ?? "0")) || 0;
  const total = parseFloat(String(inv.totalAmount ?? "0")) || 0;

  addTotalRow("Subtotal", fmtUsd(subtotal));
  if (tax > 0) addTotalRow("Tax", fmtUsd(tax));
  doc.moveDown(0.3);
  const totalBoxY = doc.y - 4;
  doc.rect(totX - 10, totalBoxY, 210, 20).fill(NAVY);
  doc.y = totalBoxY + 4;
  doc.fillColor(CREAM).font("Helvetica-Bold").fontSize(9)
    .text("TOTAL DUE", totX, doc.y, { width: 120, align: "right" });
  doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(11)
    .text(fmtUsd(total), totX + 124, totalBoxY + 4, { width: 76, align: "right" });
  doc.y = totalBoxY + 24;

  // ── Notes ────────────────────────────────────────────────────────────────
  if (inv.notes && inv.notes.trim()) {
    doc.moveDown(1);
    sectionHeader(doc, "Notes");
    doc.fillColor(TEXT).font("Helvetica").fontSize(9)
      .text(inv.notes.trim(), 56, doc.y, { width: W - 112, lineGap: 2 });
  }

  // ── Payment footer ────────────────────────────────────────────────────────
  doc.moveDown(1.5);
  if (doc.y > doc.page.height - 90) doc.addPage();
  doc.rect(56, doc.y, W - 112, 48).fill(CREAM);
  const ftY = doc.y + 10;
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(9)
    .text("Payment information", 66, ftY);
  doc.fillColor(MUTED).font("Helvetica").fontSize(8)
    .text(
      "Please reference the invoice number on payment. For questions, contact billing@williamscouncilsecurity.com.",
      66, ftY + 13, { width: W - 132 },
    );
  doc.y += 58;

  // Page footer
  const pfY = doc.page.height - 36;
  doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(
    `Generated ${new Date().toLocaleString()}  ·  Williams Council Security Group  ·  Invoice ${inv.invoiceNumber}`,
    56, pfY, { width: W - 112, align: "center", lineBreak: false },
  );

  doc.end();

  const safeNum = inv.invoiceNumber.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const filename = `wcsg-invoice-${safeNum}.pdf`;

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
