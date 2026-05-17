import PDFDocument from "pdfkit";
import { Readable } from "node:stream";
import { eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  licensesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";

const objectStorage = new ObjectStorageService();

// WCSG brand tokens — mirror lib/incidentPdf.ts so the two documents
// look like one product family when printed side-by-side.
const NAVY = "#080c18";
const GOLD = "#c9a84c";
const CREAM = "#f0e6c8";
const MUTED = "#666666";
const TEXT = "#1a1a1a";

export type ProfilePdfPayload = {
  filename: string;
  stream: Readable;
};

/**
 * Mask a US-style routing/account number to its last 4 digits.
 * Returns "—" when input is missing so the PDF never renders an empty
 * line that an unscrupulous reader could fill in.
 */
function maskTail(v: string | null | undefined, keep = 4): string {
  if (!v) return "—";
  const s = String(v);
  if (s.length <= keep) return "•".repeat(s.length);
  return "•".repeat(Math.max(4, s.length - keep)) + s.slice(-keep);
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Render a branded WCSG officer profile PDF — every section the officer
 * sees on their mobile Profile screen plus their admin Personnel row,
 * suitable for handing to a client site, an off-the-shelf onboarding
 * partner, or for the officer's own records.
 *
 * Sensitive fields are deliberately masked or omitted:
 *  - SSN: only the last 4 digits ever leave the database to begin with,
 *    here we render it as `••• •• 1234`.
 *  - Bank account number: last 4 digits only.
 *  - Routing / sort code: last 4 digits only.
 * Documents (CV, license scan, passport, training certs) are referenced
 * by filename — NOT embedded, NOT linked — because the PDF can be
 * shared outside the auth boundary. The signed-URL paths only work for
 * the owning officer / admins.
 *
 * The photo on file IS embedded inline (downscaled to a passport-style
 * thumb), because most consumers of this PDF expect a face shot.
 *
 * Authorization is enforced at the route layer — this function happily
 * renders any employee id it can find.
 */
export async function buildEmployeeProfilePdf(
  userId: string,
  opts: { redactForPublicShare?: boolean } = {},
): Promise<ProfilePdfPayload | null> {
  // When `redactForPublicShare` is true we strip every field that would
  // leak personal contact info, financial details, or internal HR data
  // over the unauthenticated share-link surface intended for client
  // contacts. Bank + SSN are ALREADY masked in the normal output; the
  // public surface drops those sections entirely (along with email,
  // phone, address, DOB, references, emergency contact, hourly rate
  // and acknowledgement signatures).
  const redactPublic = opts.redactForPublicShare === true;
  const [row] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
      status: usersTable.status,
      phone: employeesTable.phone,
      address: employeesTable.address,
      dateOfBirth: employeesTable.dateOfBirth,
      cityOfBirth: employeesTable.cityOfBirth,
      stateOfBirth: employeesTable.stateOfBirth,
      niNumber: employeesTable.niNumber,
      rightToWorkStatus: employeesTable.rightToWorkStatus,
      siaLicenseNumber: employeesTable.siaLicenseNumber,
      siaLicenseLevel: employeesTable.siaLicenseLevel,
      siaLicenseExpiry: employeesTable.siaLicenseExpiry,
      previousExperience: employeesTable.previousExperience,
      yearsExperience: employeesTable.yearsExperience,
      references: employeesTable.references,
      photoKey: employeesTable.photoKey,
      cvKey: employeesTable.cvKey,
      licenseDocKey: employeesTable.licenseDocKey,
      passportDocKey: employeesTable.passportDocKey,
      rightToWorkDocKey: employeesTable.rightToWorkDocKey,
      payStubDocKey: employeesTable.payStubDocKey,
      trainingCertificateKeys: employeesTable.trainingCertificateKeys,
      emergencyContactName: employeesTable.emergencyContactName,
      emergencyContactRelationship: employeesTable.emergencyContactRelationship,
      emergencyContactPhone: employeesTable.emergencyContactPhone,
      hourlyRate: employeesTable.hourlyRate,
      bankAccountName: employeesTable.bankAccountName,
      bankAccountNumber: employeesTable.bankAccountNumber,
      bankBsb: employeesTable.bankBsb,
      taxCode: employeesTable.taxCode,
      uniformShirt: employeesTable.uniformShirt,
      uniformTrousers: employeesTable.uniformTrousers,
      uniformJacket: employeesTable.uniformJacket,
      uniformBoots: employeesTable.uniformBoots,
      directDepositConsent: employeesTable.directDepositConsent,
      acknowledgements: employeesTable.acknowledgements,
      skills: employeesTable.skills,
    })
    .from(usersTable)
    .leftJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
    .where(and(eq(usersTable.id, userId), eq(usersTable.role, "employee")));

  if (!row) return null;

  const licenses = await db
    .select({
      id: licensesTable.id,
      type: licensesTable.type,
      licenseNumber: licensesTable.licenseNumber,
      level: licensesTable.level,
      issueDate: licensesTable.issueDate,
      expiryDate: licensesTable.expiryDate,
    })
    .from(licensesTable)
    .where(eq(licensesTable.employeeId, userId));

  // Pre-fetch the profile photo if available so we can embed it.
  let photoBuf: Buffer | null = null;
  if (row.photoKey) {
    try {
      const url = await objectStorage.getSignedDownloadURL(row.photoKey, 60);
      const r = await fetch(url);
      if (r.ok) {
        const ct = r.headers.get("content-type") ?? "";
        if (/^image\/(png|jpe?g)/i.test(ct)) {
          photoBuf = Buffer.from(await r.arrayBuffer());
        }
      }
    } catch (err) {
      logger.warn({ err, path: row.photoKey }, "[profilePdf] could not fetch photo");
    }
  }

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: {
      Title: `Officer Profile — ${row.firstName} ${row.lastName}`,
      Author: "Williams Council Security Group",
      Subject: `Profile ${row.id}`,
      CreationDate: new Date(),
    },
  });

  // Header band.
  doc.rect(0, 0, doc.page.width, 80).fill(NAVY);
  doc.fillColor(GOLD)
    .font("Helvetica-Bold").fontSize(20)
    .text("Williams Council Security Group", 56, 22);
  doc.fillColor(CREAM)
    .font("Helvetica").fontSize(10)
    .text("Confidential Officer Profile", 56, 50);
  doc.rect(0, 80, doc.page.width, 3).fill(GOLD);

  // Hero: name + photo + role badge.
  doc.y = 100;
  const heroTop = doc.y;
  const photoX = doc.page.width - 56 - 110;
  const photoY = heroTop;
  if (photoBuf) {
    try {
      doc.save();
      doc.rect(photoX, photoY, 110, 130).clip();
      doc.image(photoBuf, photoX, photoY, { fit: [110, 130], align: "center", valign: "center" });
      doc.restore();
      doc.rect(photoX, photoY, 110, 130).strokeColor(GOLD).lineWidth(1).stroke();
    } catch (err) {
      logger.warn({ err }, "[profilePdf] photo embed failed");
    }
  }

  doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(22)
    .text(`${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(), 56, heroTop, { width: photoX - 56 - 12 });
  doc.fillColor(MUTED).font("Helvetica").fontSize(11)
    .text("SECURITY OFFICER", 56, doc.y + 2);
  if (row.hourlyRate && !redactPublic) {
    doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(12)
      .text(`$${Number(row.hourlyRate).toFixed(2)} / hour`, 56, doc.y + 6);
  }

  // Make sure body starts below both the text block and the photo box.
  doc.y = Math.max(doc.y + 12, photoY + 130 + 16);

  // Section helper.
  const section = (label: string) => {
    doc.moveDown(0.6);
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text(label.toUpperCase(), 56, doc.y);
    const lineY = doc.y + 2;
    doc.moveTo(56, lineY).lineTo(doc.page.width - 56, lineY).strokeColor(GOLD).lineWidth(0.7).stroke();
    doc.moveDown(0.5);
  };
  const rowGap = 14;
  const labelW = 130;
  const valueX = 56 + labelW + 10;
  const writeRows = (rows: Array<[string, string | number | null | undefined]>) => {
    for (const [k, v] of rows) {
      const value = v === null || v === undefined || v === "" ? "—" : String(v);
      if (doc.y > doc.page.height - 90) doc.addPage();
      const y = doc.y;
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9).text(k, 56, y, { width: labelW });
      doc.fillColor(TEXT).font("Helvetica").fontSize(10).text(value, valueX, y, { width: doc.page.width - valueX - 56 });
      doc.y = Math.max(doc.y, y + rowGap);
    }
  };

  if (!redactPublic) {
    section("Contact");
    writeRows([
      ["Email", row.email],
      ["Phone", row.phone],
      ["Address", row.address],
    ]);

    section("Personal details");
    writeRows([
      ["Date of birth", row.dateOfBirth],
      ["City of birth", row.cityOfBirth],
      ["State of birth", row.stateOfBirth],
      ["SSN (last 4)", row.niNumber ? `••• •• ${String(row.niNumber).slice(-4)}` : null],
      ["Right to work", row.rightToWorkStatus],
    ]);

    section("Emergency contact");
    writeRows([
      ["Name", row.emergencyContactName],
      ["Relationship", row.emergencyContactRelationship],
      ["Phone", row.emergencyContactPhone],
    ]);
  } else {
    section("Right to work");
    writeRows([
      ["Status", row.rightToWorkStatus],
    ]);
  }

  section("TX security license");
  writeRows([
    ["License number", row.siaLicenseNumber],
    ["Level", row.siaLicenseLevel ? `L${row.siaLicenseLevel}` : null],
    ["Expires", row.siaLicenseExpiry],
  ]);

  if (licenses.length > 0) {
    section(`Licenses on record (${licenses.length})`);
    writeRows(licenses.map((l) => [
      `${l.type}${l.level ? ` · L${l.level}` : ""}`,
      `#${l.licenseNumber} · expires ${fmtDate(l.expiryDate)}`,
    ] as [string, string]));
  }

  section("Uniform sizes");
  writeRows([
    ["Shirt", row.uniformShirt],
    ["Trousers", row.uniformTrousers],
    ["Jacket", row.uniformJacket],
    ["Boots", row.uniformBoots],
  ]);

  if (!redactPublic) {
    section("Banking & tax (masked)");
    writeRows([
      ["Account name", row.bankAccountName],
      ["Account number", maskTail(row.bankAccountNumber)],
      ["Routing / sort code", maskTail(row.bankBsb)],
      ["Tax code", row.taxCode],
      ["Direct deposit consent",
        row.directDepositConsent === true ? "Yes"
        : row.directDepositConsent === false ? "No"
        : null],
    ]);
  }

  section("Experience");
  writeRows([
    ["Years", row.yearsExperience],
  ]);
  if (row.previousExperience) {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.fillColor(TEXT).font("Helvetica").fontSize(10)
      .text(row.previousExperience, 56, doc.y + 2, { width: doc.page.width - 112, lineGap: 2 });
    doc.moveDown(0.4);
  }

  const refs = Array.isArray(row.references) ? row.references as Array<Record<string, unknown>> : [];
  if (refs.length > 0 && !redactPublic) {
    section(`References (${refs.length})`);
    for (const r of refs) {
      const name = String(r?.name ?? "—");
      const rel = r?.relationship ? ` · ${r.relationship}` : "";
      const phone = r?.phone ? ` · ${r.phone}` : "";
      const email = r?.email ? ` · ${r.email}` : "";
      if (doc.y > doc.page.height - 90) doc.addPage();
      doc.fillColor(TEXT).font("Helvetica").fontSize(10)
        .text(`${name}${rel}${phone}${email}`, 56, doc.y, { width: doc.page.width - 112 });
      doc.moveDown(0.3);
    }
  }

  const skills = Array.isArray(row.skills) ? row.skills as string[] : [];
  if (skills.length > 0) {
    section("Skills & qualifications");
    doc.fillColor(TEXT).font("Helvetica").fontSize(10)
      .text(skills.join(" · "), 56, doc.y, { width: doc.page.width - 112 });
    doc.moveDown(0.4);
  }

  // Documents — reference by filename only, NEVER embed.
  const docs: Array<[string, string | null | undefined]> = [
    ["Photo", row.photoKey],
    ["CV / résumé", row.cvKey],
    ["TX security license", row.licenseDocKey],
    ["Passport / photo ID", row.passportDocKey],
    ["Right-to-work doc", row.rightToWorkDocKey],
    ["W-2 / pay stub", row.payStubDocKey],
  ];
  const certs = Array.isArray(row.trainingCertificateKeys) ? row.trainingCertificateKeys as string[] : [];
  certs.forEach((k, i) => docs.push([`Training certificate ${i + 1}`, k]));
  const presentDocs = docs.filter(([, v]) => !!v);
  if (presentDocs.length > 0) {
    section(`Documents on file (${presentDocs.length})`);
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9)
      .text("Files are stored securely. Originals are available to HR via the admin portal.", 56, doc.y, { width: doc.page.width - 112 });
    doc.moveDown(0.4);
    writeRows(presentDocs.map(([label, path]) => [label, path!.split("/").pop() ?? "(on file)"] as [string, string]));
  }

  const acks = row.acknowledgements && typeof row.acknowledgements === "object"
    ? (Array.isArray(row.acknowledgements)
        ? row.acknowledgements as Array<Record<string, unknown>>
        : Object.values(row.acknowledgements) as Array<Record<string, unknown>>)
    : [];
  if (acks.length > 0 && !redactPublic) {
    section(`Acknowledgements (${acks.length})`);
    for (const a of acks) {
      const type = String(a?.type ?? "Acknowledgement");
      const mark = a?.accepted ? "✓" : "✗";
      const sig = a?.signature ? ` — signed “${a.signature}”` : "";
      const ts = a?.timestamp ? ` on ${fmtDate(a.timestamp as string)}` : "";
      if (doc.y > doc.page.height - 90) doc.addPage();
      doc.fillColor(a?.accepted ? "#1f7a1f" : "#a33").font("Helvetica-Bold").fontSize(10)
        .text(`${mark} ${type}`, 56, doc.y, { continued: true });
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(`${sig}${ts}`);
      doc.moveDown(0.3);
    }
  }

  // Footer on the final page.
  const footerY = doc.page.height - 36;
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(
    `Generated ${new Date().toLocaleString()} · Williams Council Security Group · Confidential — do not distribute`,
    56, footerY,
    { width: doc.page.width - 112, align: "center", lineBreak: false },
  );

  doc.end();

  const safeName = `${row.firstName ?? ""}-${row.lastName ?? ""}`
    .replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "officer";
  const filename = `wcsg-profile-${safeName}-${new Date().toISOString().slice(0, 10)}.pdf`;
  return { filename, stream: doc as unknown as Readable };
}
