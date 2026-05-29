import PDFDocument from "pdfkit";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import {
  db,
  dailyActivityReportsTable,
  usersTable,
  shiftsTable,
  sitesTable,
} from "@workspace/db";
import { brand } from "./brandConfig";

const NAVY = brand.colorNavy;
const GOLD = brand.colorGold;
const CREAM = brand.colorCream;
const MUTED = "#666666";
const TEXT = "#1a1a1a";

export type DarPdfPayload = {
  filename: string;
  stream: Readable;
};

export type DarPdfOptions = {
  /**
   * When true, officer PII (full name, email, signature) is redacted
   * from the PDF. Use this for any client-portal or external-facing
   * download where the recipient is not entitled to see staff details.
   */
  redactForClient?: boolean;
};

/**
 * Render a WCSG Daily Activity Report as a branded PDF stream.
 *
 * Authorization is enforced at the route layer — this function only
 * checks that the report exists. Output mirrors the incident PDF
 * (cover bar, gold underline section heads, single-page footer) so
 * client deliverables feel like one product.
 *
 * Pass `{ redactForClient: true }` to strip officer PII (name/email/signature)
 * before serving to external client-portal users.
 */
export async function buildDarPdf(darId: string, opts: DarPdfOptions = {}): Promise<DarPdfPayload | null> {
  const { redactForClient = false } = opts;
  const [row] = await db
    .select({
      id: dailyActivityReportsTable.id,
      reportDate: dailyActivityReportsTable.reportDate,
      submittedAt: dailyActivityReportsTable.submittedAt,
      summary: dailyActivityReportsTable.summary,
      observations: dailyActivityReportsTable.observations,
      visitorsCount: dailyActivityReportsTable.visitorsCount,
      patrolsCount: dailyActivityReportsTable.patrolsCount,
      incidentsNoted: dailyActivityReportsTable.incidentsNoted,
      weather: dailyActivityReportsTable.weather,
      signature: dailyActivityReportsTable.signature,
      employeeFirst: usersTable.firstName,
      employeeLast: usersTable.lastName,
      employeeEmail: usersTable.email,
      siteName: sitesTable.name,
      siteAddress: sitesTable.address,
      shiftTitle: shiftsTable.title,
      shiftStart: shiftsTable.startTime,
      shiftEnd: shiftsTable.endTime,
    })
    .from(dailyActivityReportsTable)
    .leftJoin(usersTable, eq(usersTable.id, dailyActivityReportsTable.employeeId))
    .leftJoin(sitesTable, eq(sitesTable.id, dailyActivityReportsTable.siteId))
    .leftJoin(shiftsTable, eq(shiftsTable.id, dailyActivityReportsTable.shiftId))
    .where(eq(dailyActivityReportsTable.id, darId));

  if (!row) return null;

  const doc = new PDFDocument({ size: "LETTER", margin: 56, bufferPages: true });

  // Header bar.
  doc.rect(0, 0, doc.page.width, 80).fill(NAVY);
  doc.fillColor(GOLD)
    .font("Helvetica-Bold").fontSize(20)
    .text(brand.companyName, 56, 22);
  doc.fillColor(CREAM)
    .font("Helvetica").fontSize(10)
    .text("Daily Activity Report", 56, 50);
  doc.rect(0, 80, doc.page.width, 3).fill(GOLD);

  // Title row.
  doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(18)
    .text(`Activity Report — ${row.reportDate}`, 56, 110, { width: 480 });
  doc.y = Math.max(doc.y, 138);
  doc.moveDown(0.5);

  // Metadata.
  const fmtDate = (d: Date | null) => (d ? new Date(d).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) : "—");
  const officer = [row.employeeFirst, row.employeeLast].filter(Boolean).join(" ") || "—";

  // Client-facing PDFs redact officer PII: full name, email, and signature
  // are never visible to external clients. Only operational content
  // (site, shift window, counts, narrative) is included.
  const meta: Array<[string, string]> = [
    ["Report ID", row.id],
    ["Report Date", row.reportDate],
    ["Submitted", fmtDate(row.submittedAt)],
    // Officer name/email omitted when redacting for client
    ...(!redactForClient ? [
      ["Officer", officer],
      ["Officer Email", row.employeeEmail ?? "—"],
    ] as Array<[string, string]> : []),
    ["Site", row.siteName ?? "—"],
    ["Site Address", row.siteAddress ?? "—"],
    ["Shift", row.shiftTitle ? `${row.shiftTitle} (${fmtDate(row.shiftStart)} → ${fmtDate(row.shiftEnd)})` : "—"],
    ["Weather", row.weather ?? "—"],
    ["Visitors", String(row.visitorsCount)],
    ["Patrols", String(row.patrolsCount)],
  ];

  const labelX = 56;
  const valueX = 170;
  let metaY = doc.y + 6;
  for (const [k, v] of meta) {
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9).text(k, labelX, metaY, { width: 110 });
    doc.fillColor(TEXT).font("Helvetica").fontSize(10).text(v, valueX, metaY, { width: doc.page.width - valueX - 56 });
    metaY = doc.y + 4;
  }

  // Summary.
  doc.moveDown(1);
  sectionHeader(doc, "Summary");
  doc.fillColor(TEXT).font("Helvetica").fontSize(11)
    .text(row.summary, 56, doc.y, { width: doc.page.width - 112, lineGap: 2 });

  if (row.observations) {
    doc.moveDown(1);
    sectionHeader(doc, "Observations");
    doc.fillColor(TEXT).font("Helvetica").fontSize(11)
      .text(row.observations, 56, doc.y, { width: doc.page.width - 112, lineGap: 2 });
  }

  if (row.incidentsNoted) {
    doc.moveDown(1);
    sectionHeader(doc, "Incidents Noted");
    doc.fillColor(TEXT).font("Helvetica").fontSize(11)
      .text(row.incidentsNoted, 56, doc.y, { width: doc.page.width - 112, lineGap: 2 });
  }

  // Signature is officer PII — omitted from client-facing PDFs.
  if (row.signature && !redactForClient) {
    doc.moveDown(1.2);
    sectionHeader(doc, "Officer Signature");
    doc.fillColor(TEXT).font("Helvetica-Oblique").fontSize(14)
      .text(row.signature, 56, doc.y);
    doc.fillColor(MUTED).font("Helvetica").fontSize(9)
      .text(`Signed electronically · Submitted ${fmtDate(row.submittedAt)}`, 56, doc.y + 4);
  }

  const footerY = doc.page.height - 36;
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(
    `Generated ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} · ${brand.companyName} · Confidential`,
    56, footerY,
    { width: doc.page.width - 112, align: "center", lineBreak: false },
  );

  doc.end();

  // Redacted PDFs use a generic filename so officer identity is not
  // leaked even through the Content-Disposition header.
  const shortName = brand.shortName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  const filename = redactForClient
    ? `${shortName}-dar-${row.reportDate}.pdf`
    : (() => {
        const safeOfficer = officer.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 30) || "officer";
        return `${shortName}-dar-${row.reportDate}-${safeOfficer}.pdf`;
      })();
  return { filename, stream: doc as unknown as Readable };
}

function sectionHeader(doc: PDFKit.PDFDocument, label: string): void {
  const y = doc.y;
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text(label.toUpperCase(), 56, y);
  const lineY = doc.y + 2;
  doc.moveTo(56, lineY).lineTo(doc.page.width - 56, lineY).strokeColor(GOLD).lineWidth(0.7).stroke();
  doc.moveDown(0.6);
}
