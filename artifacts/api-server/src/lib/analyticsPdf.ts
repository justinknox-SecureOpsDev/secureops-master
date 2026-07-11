import PDFDocument from "pdfkit";
import type { Readable } from "node:stream";
import { brand } from "./brandConfig";
import { drawBrandHeader } from "./pdfHeader";

const NAVY = brand.colorNavy;
const GOLD = brand.colorGold;
const MUTED = "#666666";
const TEXT = "#1a1a1a";

export type AnalyticsReportInput = {
  revenue: number;
  laborCost: number;
  profit: number;
  marginPct: number;
  hoursWorked: number;
  hoursScheduled: number;
  coveragePct: number;
  noShowCount: number;
  unfilledCount: number;
  incidentTotal: number;
  incidentsBySeverity: Record<string, number>;
  incidentsByStatus: Record<string, number>;
  perSite: Array<{
    siteId: string;
    siteName: string;
    revenue: number;
    laborCost: number;
    profit: number;
    hoursWorked: number;
    hoursScheduled: number;
    noShows: number;
    unfilledShifts: number;
    incidents: number;
  }>;
};

export type AnalyticsPdfPayload = {
  filename: string;
  stream: Readable;
};

const fmtUsd = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const fmtDate = (iso: string): string =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });

function sectionHeader(doc: PDFKit.PDFDocument, label: string): void {
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(9)
    .text(label.toUpperCase(), 56, doc.y, { characterSpacing: 0.5 });
  const lineY = doc.y + 2;
  doc.moveTo(56, lineY).lineTo(doc.page.width - 56, lineY)
    .strokeColor(GOLD).lineWidth(0.7).stroke();
  doc.moveDown(0.6);
}

/**
 * Render the branded analytics report PDF (summary KPIs, incident counts,
 * per-site breakdown table) for an inclusive [start, end] date range.
 *
 * The caller is responsible for Content-Type / Content-Disposition headers
 * and piping the stream. Authorization is enforced at the route layer.
 */
export function buildAnalyticsReportPdf(
  data: AnalyticsReportInput,
  start: string,
  end: string,
): AnalyticsPdfPayload {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: {
      Title: `Analytics Report ${start} – ${end}`,
      Author: brand.companyName,
      Subject: `Operations analytics ${start} – ${end}`,
      CreationDate: new Date(),
    },
  });

  const W = doc.page.width;
  const top = drawBrandHeader(doc, `${brand.tagline}  ·  Analytics Report`);

  // ── Period line ────────────────────────────────────────────────────────
  doc.y = top + 10;
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8)
    .text("REPORTING PERIOD", 56, doc.y, { characterSpacing: 0.8 });
  doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(12)
    .text(`${fmtDate(start)} – ${fmtDate(end)}`, 56, doc.y + 2);
  doc.moveDown(1);

  // ── KPI cards (3 × 3 grid) ─────────────────────────────────────────────
  sectionHeader(doc, "Summary");
  const kpis: Array<[string, string, string?]> = [
    ["Revenue", fmtUsd(data.revenue)],
    ["Labor Cost", fmtUsd(data.laborCost)],
    ["Profit", fmtUsd(data.profit), data.profit >= 0 ? "#15803d" : "#b91c1c"],
    ["Margin", `${data.marginPct.toFixed(1)}%`],
    ["Hours Worked", `${data.hoursWorked.toFixed(1)} h`],
    ["Hours Scheduled", `${data.hoursScheduled.toFixed(1)} h`],
    ["Coverage", `${data.coveragePct.toFixed(1)}%`],
    ["No-Shows", String(data.noShowCount)],
    ["Unfilled Shifts", String(data.unfilledCount)],
  ];
  const cardW = (W - 112 - 2 * 10) / 3;
  const cardH = 44;
  const gridTop = doc.y;
  kpis.forEach(([label, value, color], i) => {
    const col = i % 3;
    const rowIdx = Math.floor(i / 3);
    const x = 56 + col * (cardW + 10);
    const y = gridTop + rowIdx * (cardH + 8);
    doc.rect(x, y, cardW, cardH).fill("#f7f7f7");
    doc.moveTo(x, y).lineTo(x + cardW, y).strokeColor(GOLD).lineWidth(1).stroke();
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7)
      .text(label.toUpperCase(), x + 10, y + 8, { width: cardW - 20, characterSpacing: 0.5 });
    doc.fillColor(color ?? NAVY).font("Helvetica-Bold").fontSize(14)
      .text(value, x + 10, y + 20, { width: cardW - 20, lineBreak: false });
  });
  doc.y = gridTop + 3 * (cardH + 8) + 8;

  // ── Incidents ──────────────────────────────────────────────────────────
  sectionHeader(doc, `Incidents — ${data.incidentTotal} total`);
  const sevY = doc.y;
  doc.fillColor(TEXT).font("Helvetica").fontSize(9).text(
    `By severity:  low ${data.incidentsBySeverity.low ?? 0}   ·   medium ${data.incidentsBySeverity.medium ?? 0}   ·   high ${data.incidentsBySeverity.high ?? 0}   ·   critical ${data.incidentsBySeverity.critical ?? 0}`,
    56, sevY,
  );
  doc.fillColor(TEXT).font("Helvetica").fontSize(9).text(
    `By status:  open ${data.incidentsByStatus.open ?? 0}   ·   investigating ${data.incidentsByStatus.investigating ?? 0}   ·   closed ${data.incidentsByStatus.closed ?? 0}`,
    56, doc.y + 4,
  );
  doc.moveDown(1.2);

  // ── Per-site breakdown table ───────────────────────────────────────────
  sectionHeader(doc, "Per-Site Breakdown");

  const cols: Array<{ label: string; w: number; align: "left" | "right" }> = [
    { label: "Site", w: 128, align: "left" },
    { label: "Revenue", w: 62, align: "right" },
    { label: "Labor", w: 62, align: "right" },
    { label: "Profit", w: 62, align: "right" },
    { label: "Hrs Wkd", w: 46, align: "right" },
    { label: "Hrs Sch", w: 46, align: "right" },
    { label: "No-Show", w: 42, align: "right" },
    { label: "Unfilled", w: 40, align: "right" },
    { label: "Incid.", w: 34, align: "right" },
  ];

  const drawTableHeader = () => {
    const th = doc.y;
    doc.rect(56, th - 2, W - 112, 16).fill("#eef0f3");
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7.5);
    let x = 60;
    for (const c of cols) {
      doc.text(c.label, x, th + 1, { width: c.w - 6, align: c.align, lineBreak: false });
      x += c.w;
    }
    doc.y = th + 17;
  };

  const sites = [...data.perSite].sort((a, b) => b.revenue - a.revenue);
  if (sites.length === 0) {
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9)
      .text("No site activity in this period.", 56, doc.y);
  } else {
    drawTableHeader();
    sites.forEach((s, i) => {
      if (doc.y > doc.page.height - 90) {
        doc.addPage();
        doc.y = 56;
        drawTableHeader();
      }
      const rowY = doc.y;
      if (i % 2 === 1) doc.rect(56, rowY - 1, W - 112, 15).fill("#fafafa");
      const cells: string[] = [
        s.siteName,
        fmtUsd(s.revenue),
        fmtUsd(s.laborCost),
        fmtUsd(s.profit),
        s.hoursWorked.toFixed(1),
        s.hoursScheduled.toFixed(1),
        String(s.noShows),
        String(s.unfilledShifts),
        String(s.incidents),
      ];
      let x = 60;
      cells.forEach((cell, ci) => {
        const c = cols[ci];
        const isProfit = ci === 3;
        doc.fillColor(isProfit ? (s.profit >= 0 ? "#15803d" : "#b91c1c") : TEXT)
          .font(ci === 0 || isProfit ? "Helvetica-Bold" : "Helvetica").fontSize(8);
        doc.text(cell, x, rowY + 1, { width: c.w - 6, align: c.align, lineBreak: false });
        x += c.w;
      });
      doc.y = rowY + 15;
    });

    // Totals row
    doc.moveTo(56, doc.y + 1).lineTo(W - 56, doc.y + 1).strokeColor("#ddd").lineWidth(0.5).stroke();
    const totY = doc.y + 5;
    const totals: string[] = [
      "All sites",
      fmtUsd(sites.reduce((a, s) => a + s.revenue, 0)),
      fmtUsd(sites.reduce((a, s) => a + s.laborCost, 0)),
      fmtUsd(sites.reduce((a, s) => a + s.profit, 0)),
      sites.reduce((a, s) => a + s.hoursWorked, 0).toFixed(1),
      sites.reduce((a, s) => a + s.hoursScheduled, 0).toFixed(1),
      String(sites.reduce((a, s) => a + s.noShows, 0)),
      String(sites.reduce((a, s) => a + s.unfilledShifts, 0)),
      String(sites.reduce((a, s) => a + s.incidents, 0)),
    ];
    let x = 60;
    totals.forEach((cell, ci) => {
      const c = cols[ci];
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(8);
      doc.text(cell, x, totY, { width: c.w - 6, align: c.align, lineBreak: false });
      x += c.w;
    });
    doc.y = totY + 16;
  }

  // ── Page footer ────────────────────────────────────────────────────────
  const pfY = doc.page.height - 36;
  doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(
    `Generated ${new Date().toLocaleString("en-US")}  ·  ${brand.companyName}  ·  Analytics ${start} – ${end}`,
    56, pfY, { width: W - 112, align: "center", lineBreak: false },
  );

  doc.end();

  const safeShort = brand.shortName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  const filename = `${safeShort}-analytics-${start}_${end}.pdf`;

  return { filename, stream: doc as unknown as Readable };
}
