import PDFDocument from "pdfkit";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import {
  db,
  incidentsTable,
  usersTable,
  shiftsTable,
  sitesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import { brand } from "./brandConfig";

const objectStorage = new ObjectStorageService();

// Brand colors read from env so each client deployment gets its own palette.
const NAVY = brand.colorNavy;
const GOLD = brand.colorGold;
const CREAM = brand.colorCream;
const MUTED = "#666666";
const TEXT = "#1a1a1a";

const SEVERITY_COLOR: Record<string, string> = {
  low: "#4b5563",
  medium: "#b45309",
  high: "#b91c1c",
  critical: "#7f1d1d",
};

export type IncidentPdfPayload = {
  filename: string;
  stream: Readable;
};

/**
 * Render a branded WCSG incident report as a PDF stream.
 *
 * The caller is responsible for setting Content-Type / Content-Disposition
 * headers and piping the returned stream to the response. Authorization
 * is enforced at the route layer — this function does not check ACLs and
 * will happily render any incident id it can find.
 *
 * Design notes:
 *  - Uses the built-in Helvetica family so we never have to ship a font.
 *  - Image attachments are embedded inline (downscaled to fit a 480-pt
 *    grid). We try to resolve them via signed-URL fetch so private
 *    object-storage paths work; on any failure (network, non-image,
 *    unsupported codec) we render a small "[image unavailable]" footer
 *    instead of crashing the report.
 *  - Layout is intentionally single-column and spacious so the PDF reads
 *    well when printed for a client / insurance handover.
 */
export async function buildIncidentReportPdf(
  incidentId: string,
  opts: { redactForPublicShare?: boolean } = {},
): Promise<IncidentPdfPayload | null> {
  // When `redactForPublicShare` is true we strip every field that would
  // leak internal context or employee PII over the unauthenticated share
  // link surface: admin notes, officer email/phone, and full officer
  // name (replaced with initial + last name).
  const redact = opts.redactForPublicShare === true;
  const [row] = await db
    .select({
      id: incidentsTable.id,
      title: incidentsTable.title,
      description: incidentsTable.description,
      severity: incidentsTable.severity,
      status: incidentsTable.status,
      locationDescription: incidentsTable.locationDescription,
      lat: incidentsTable.lat,
      lng: incidentsTable.lng,
      occurredAt: incidentsTable.occurredAt,
      resolvedAt: incidentsTable.resolvedAt,
      adminNotes: incidentsTable.adminNotes,
      attachments: incidentsTable.attachments,
      createdAt: incidentsTable.createdAt,
      employeeId: incidentsTable.employeeId,
      employeeFirst: usersTable.firstName,
      employeeLast: usersTable.lastName,
      employeeEmail: usersTable.email,
      employeePhone: usersTable.phoneNumber,
      shiftTitle: shiftsTable.title,
      shiftStart: shiftsTable.startTime,
      shiftEnd: shiftsTable.endTime,
      siteName: sitesTable.name,
      siteAddress: sitesTable.address,
    })
    .from(incidentsTable)
    .leftJoin(usersTable, eq(usersTable.id, incidentsTable.employeeId))
    .leftJoin(shiftsTable, eq(shiftsTable.id, incidentsTable.shiftId))
    .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
    .where(eq(incidentsTable.id, incidentId));

  if (!row) return null;

  // Pre-fetch attachment image bytes BEFORE we start writing the PDF —
  // PDFKit needs full buffers (no streaming images), and gathering them
  // upfront also lets us know which attachments are renderable so the
  // page layout can flow without leaving giant gaps.
  const attachmentPaths: string[] = Array.isArray(row.attachments) ? row.attachments : [];
  const fetchedImages = await Promise.all(
    attachmentPaths.map(async (path) => {
      try {
        const url = await objectStorage.getSignedDownloadURL(path, 60);
        const r = await fetch(url);
        if (!r.ok) return { path, ok: false as const };
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = r.headers.get("content-type") ?? "";
        if (!/^image\/(png|jpe?g)/i.test(ct)) return { path, ok: false as const };
        return { path, ok: true as const, buf };
      } catch (err) {
        logger.warn({ err, path }, "[incidentPdf] could not fetch attachment");
        return { path, ok: false as const };
      }
    }),
  );

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: {
      Title: `Incident Report — ${row.title}`,
      Author: brand.companyName,
      Subject: `Incident ${row.id}`,
      CreationDate: new Date(),
    },
  });

  // Header band — navy + gold rule.
  doc.rect(0, 0, doc.page.width, 80).fill(NAVY);
  doc.fillColor(GOLD)
    .font("Helvetica-Bold").fontSize(20)
    .text(brand.companyName, 56, 22);
  doc.fillColor(CREAM)
    .font("Helvetica").fontSize(10)
    .text("Confidential Incident Report", 56, 50);
  doc.rect(0, 80, doc.page.width, 3).fill(GOLD);
  doc.moveDown(2);
  doc.y = 110;

  // Title row + severity pill.
  doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(18).text(row.title, 56, 110, { width: 380 });
  const sevColor = SEVERITY_COLOR[row.severity] ?? MUTED;
  const pillX = doc.page.width - 56 - 110;
  doc.roundedRect(pillX, 110, 110, 26, 4).fill(sevColor);
  doc.fillColor("white").font("Helvetica-Bold").fontSize(10)
    .text(row.severity.toUpperCase(), pillX, 117, { width: 110, align: "center" });
  doc.fillColor(MUTED).font("Helvetica").fontSize(9)
    .text(`Status: ${row.status}`, pillX, 140, { width: 110, align: "center" });

  doc.y = Math.max(doc.y, 160);
  doc.moveDown(0.5);

  // Metadata block — two columns.
  const fmtDate = (d: Date | null) => (d ? new Date(d).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) : "—");
  const employeeFull = [row.employeeFirst, row.employeeLast].filter(Boolean).join(" ") || "—";
  const employeeShort = row.employeeFirst && row.employeeLast
    ? `${row.employeeFirst[0]}. ${row.employeeLast}`
    : (row.employeeLast || row.employeeFirst || "—");
  const meta: Array<[string, string]> = [
    ["Report ID", row.id],
    ["Occurred", fmtDate(row.occurredAt)],
    ["Reported", fmtDate(row.createdAt)],
    ["Resolved", fmtDate(row.resolvedAt)],
    ["Officer", redact ? employeeShort : employeeFull],
    ...(redact
      ? []
      : [["Officer Contact", [row.employeeEmail, row.employeePhone].filter(Boolean).join(" · ") || "—"] as [string, string]]),
    ["Site", row.siteName ?? "—"],
    ["Site Address", row.siteAddress ?? "—"],
    ["Shift", row.shiftTitle ? `${row.shiftTitle} (${fmtDate(row.shiftStart)} → ${fmtDate(row.shiftEnd)})` : "—"],
    ["Location", row.locationDescription || (row.lat && row.lng ? `${row.lat}, ${row.lng}` : "—")],
  ];

  const labelX = 56;
  const valueX = 170;
  const rowGap = 16;
  let metaY = doc.y + 6;
  for (const [k, v] of meta) {
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9).text(k, labelX, metaY, { width: 110 });
    doc.fillColor(TEXT).font("Helvetica").fontSize(10).text(v, valueX, metaY, { width: doc.page.width - valueX - 56 });
    metaY = doc.y + 4;
  }

  // Description.
  doc.moveDown(1);
  sectionHeader(doc, "Description");
  doc.fillColor(TEXT).font("Helvetica").fontSize(11)
    .text(row.description, 56, doc.y, { width: doc.page.width - 112, align: "left", lineGap: 2 });

  // Admin notes (if any). NEVER include in the redacted/public copy —
  // these are internal-only.
  if (!redact && row.adminNotes) {
    doc.moveDown(1);
    sectionHeader(doc, "Admin Notes");
    doc.fillColor(TEXT).font("Helvetica-Oblique").fontSize(11)
      .text(row.adminNotes, 56, doc.y, { width: doc.page.width - 112, lineGap: 2 });
  }

  // Attachments.
  if (attachmentPaths.length > 0) {
    doc.moveDown(1);
    sectionHeader(doc, `Attachments (${attachmentPaths.length})`);

    for (const a of fetchedImages) {
      const filename = a.path.split("/").pop() ?? a.path;
      // Make sure each attachment fits on the current page; otherwise
      // start a new page so we never split an image weirdly.
      if (doc.y > doc.page.height - 280) doc.addPage();
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(filename, 56, doc.y);
      doc.moveDown(0.3);
      if (a.ok) {
        try {
          doc.image(a.buf, 56, doc.y, { fit: [480, 220] });
          doc.y += 230;
        } catch (err) {
          logger.warn({ err, path: a.path }, "[incidentPdf] embed failed");
          doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9)
            .text("[image could not be embedded]", 56, doc.y);
          doc.moveDown(1);
        }
      } else {
        doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9)
          .text("[image unavailable — see admin portal for original file]", 56, doc.y);
        doc.moveDown(1);
      }
    }
  }

  // Single-page footer on the FINAL page only. Earlier attempts used the
  // pageAdded event to stamp every page, but PDFKit's text flow keeps
  // re-triggering page breaks during finalize and overflows the stack.
  // Most incident reports fit on a page or two, and the cover-page header
  // already brands every page, so the bottom-of-doc footer is enough.
  const footerY = doc.page.height - 36;
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(
    `Generated ${new Date().toLocaleString()} · ${brand.companyName} · Confidential`,
    56, footerY,
    { width: doc.page.width - 112, align: "center", lineBreak: false },
  );

  doc.end();

  // Sanitize filename to ASCII so Content-Disposition is universally happy.
  const safeTitle = row.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "incident";
  const dateTag = new Date(row.occurredAt).toISOString().slice(0, 10);
  const filename = `${brand.shortName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-incident-${dateTag}-${safeTitle}.pdf`;

  return { filename, stream: doc as unknown as Readable };
}

function sectionHeader(doc: PDFKit.PDFDocument, label: string): void {
  const y = doc.y;
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text(label.toUpperCase(), 56, y);
  const lineY = doc.y + 2;
  doc.moveTo(56, lineY).lineTo(doc.page.width - 56, lineY).strokeColor(GOLD).lineWidth(0.7).stroke();
  doc.moveDown(0.6);
}
