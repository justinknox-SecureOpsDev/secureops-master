import PDFDocument from "pdfkit";
import type { Response } from "express";
import type { TimeCardData, TimeCardEntry } from "../routes/timeEntries";
import { drawBrandHeader } from "./pdfHeader";

const MARGIN = 56;
const MUTED = "#666666";
const TEXT = "#1a1a1a";
const ZEBRA = "#f4f1ea";

function fmtTime(iso: Date, tz: string): string {
  return iso.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}

function fmtDay(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function entryTimes(e: TimeCardEntry, tz: string): string {
  const inT = fmtTime(e.clockInTime, tz);
  const outT = e.open ? "open" : e.clockOutTime ? fmtTime(e.clockOutTime, tz) : "—";
  return `${inT} → ${outT}`;
}

function entryHours(e: TimeCardEntry): string {
  return e.open ? "In progress" : `${(e.hoursWorked ?? 0).toFixed(2)} h`;
}

function statusLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Build the weekly time-card CSV. Row-level data mirrors the on-screen card
 * (per-entry times/hours/status) and the summary rows reuse the pre-rounded
 * totals from the shared builder, so totals match the screen exactly.
 */
export function buildTimeCardCsv(card: TimeCardData): string {
  const lines: string[] = [];
  lines.push(`Weekly Time Card,${csvEscape(card.employeeName)}`);
  lines.push(`Week,${card.weekStart} to ${card.weekEnd}`);
  lines.push(`Timezone,${card.timezone}`);
  lines.push("");
  lines.push("Date,Day,Clock In,Clock Out,Site / Shift,Hours,Status");
  for (const day of card.days) {
    if (day.entries.length === 0) {
      lines.push(`${day.date},${csvEscape(fmtDay(day.date))},,,,0.00,`);
      continue;
    }
    for (const e of day.entries) {
      const inT = fmtTime(e.clockInTime, card.timezone);
      const outT = e.open ? "open" : e.clockOutTime ? fmtTime(e.clockOutTime, card.timezone) : "";
      const hours = e.open ? "" : (e.hoursWorked ?? 0).toFixed(2);
      lines.push([
        day.date,
        csvEscape(fmtDay(day.date)),
        inT,
        outT,
        csvEscape(e.siteName ?? e.shiftTitle ?? ""),
        hours,
        statusLabel(e.approvalStatus),
      ].join(","));
    }
  }
  lines.push("");
  lines.push(`Week total hours,${card.totalHours.toFixed(2)}`);
  lines.push(`Approved hours,${card.approvedHours.toFixed(2)}`);
  lines.push(`Pending hours,${card.pendingHours.toFixed(2)}`);
  lines.push("Note,Rejected entries are shown but excluded from totals. Totals use the same rounding as payroll.");
  return lines.join("\n") + "\n";
}

/**
 * Render the weekly time card as a branded PDF (shared drawBrandHeader band),
 * streaming straight to the response. Data comes from the same builder as the
 * JSON route, so the printed totals always match the on-screen card.
 */
export function renderTimeCardPdf(res: Response, card: TimeCardData): void {
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  doc.pipe(res);

  const top = drawBrandHeader(doc, `Weekly Time Card — ${card.employeeName}`);
  doc.y = top + 18;

  const W = doc.page.width;
  const bottom = () => doc.page.height - MARGIN - 20;

  // Week line + summary strip
  doc.font("Helvetica").fontSize(10).fillColor(MUTED)
    .text(`Week of ${card.weekStart} to ${card.weekEnd}  ·  Timezone: ${card.timezone}`, MARGIN);
  doc.moveDown(0.6);

  const summary: [string, string, string][] = [
    ["WEEK TOTAL", `${card.totalHours.toFixed(2)} h`, TEXT],
    ["APPROVED", `${card.approvedHours.toFixed(2)} h`, "#15803d"],
    ["PENDING", `${card.pendingHours.toFixed(2)} h`, "#b45309"],
  ];
  const colW = (W - MARGIN * 2) / 3;
  const sy = doc.y;
  summary.forEach(([label, value, color], i) => {
    const x = MARGIN + i * colW;
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED).text(label, x, sy, { width: colW, align: "center" });
    doc.font("Helvetica-Bold").fontSize(15).fillColor(color).text(value, x, sy + 11, { width: colW, align: "center" });
  });
  doc.y = sy + 40;

  const widths = [150, 170, 90, 90];
  const tableW = widths.reduce((a, b) => a + b, 0);

  for (const day of card.days) {
    if (doc.y + 48 > bottom()) doc.addPage();
    // Day header row
    const hy = doc.y;
    doc.rect(MARGIN, hy, tableW, 18).fill("#e9e4d6");
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(TEXT)
      .text(fmtDay(day.date), MARGIN + 4, hy + 4, { width: tableW - 110, lineBreak: false });
    doc.text(`${day.totalHours.toFixed(2)} h`, MARGIN + tableW - 100, hy + 4, { width: 96, align: "right", lineBreak: false });
    doc.y = hy + 20;

    if (day.entries.length === 0) {
      doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(MUTED).text("No entries", MARGIN + 4, doc.y);
      doc.y += 14;
      continue;
    }

    let zebra = false;
    for (const e of day.entries) {
      if (doc.y + 16 > bottom()) { doc.addPage(); doc.y = MARGIN; }
      const y = doc.y;
      if (zebra) doc.rect(MARGIN, y - 2, tableW, 15).fill(ZEBRA);
      zebra = !zebra;
      doc.font("Helvetica").fontSize(8.5).fillColor("#222222");
      const cells = [
        entryTimes(e, card.timezone),
        e.siteName ?? e.shiftTitle ?? "—",
        entryHours(e),
        statusLabel(e.approvalStatus),
      ];
      let x = MARGIN;
      for (let i = 0; i < cells.length; i++) {
        doc.text(cells[i], x + 4, y, { width: widths[i] - 8, lineBreak: false });
        x += widths[i];
      }
      doc.y = y + 15;
    }
    doc.y += 6;
  }

  if (doc.y + 30 > bottom()) doc.addPage();
  doc.moveDown(0.6);
  doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#777777").text(
    "Days follow the company timezone. Rejected entries are shown but excluded from totals. " +
    "Totals use the same rounding as payroll, so this card always agrees with the Payroll Board.",
    MARGIN,
  );
  doc.end();
}
