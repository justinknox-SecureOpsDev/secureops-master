import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";

const NAVY = "#0c0a08";
const GOLD = "#b87333";
const CREAM = "#f0e4c0";
const INK = "#1c2433";
const MUTED = "#5b6472";
const RULE = "#d8cfb4";
const ARROW = " -> ";

const OUT = path.resolve(process.env.PDF_OUT || "exports/wcsg-payroll-process.pdf");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 64, bottom: 64, left: 64, right: 64 },
  bufferPages: true,
  info: {
    Title: "WCSG SecureOps - Payroll & Invoicing Process",
    Author: "Williams Council Security Group",
    Subject: "Step-by-step: time approval to payment, and invoice population",
  },
});
const stream = fs.createWriteStream(OUT);
doc.pipe(stream);

const PAGE_W = doc.page.width;
const ML = doc.page.margins.left;
const MR = doc.page.margins.right;
const CONTENT_W = PAGE_W - ML - MR;

function ensureSpace(h) {
  if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function sectionHeader(num, title) {
  ensureSpace(64);
  const y = doc.y + 6;
  doc.save();
  doc.roundedRect(ML, y, 30, 30, 6).fill(NAVY);
  doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(15).text(String(num), ML, y + 8, { width: 30, align: "center" });
  doc.restore();
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(16).text(title, ML + 42, y + 6, { width: CONTENT_W - 42 });
  doc.moveTo(ML, y + 36).lineTo(ML + CONTENT_W, y + 36).lineWidth(1.5).strokeColor(GOLD).stroke();
  doc.moveDown(1.1);
  doc.x = ML;
}

function step(n, title, body) {
  ensureSpace(54);
  const startY = doc.y;
  doc.save();
  doc.circle(ML + 9, startY + 8, 9).fill(GOLD);
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10).text(String(n), ML, startY + 4, { width: 18, align: "center" });
  doc.restore();
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11.5).text(title, ML + 28, startY + 1, { width: CONTENT_W - 28 });
  doc.moveDown(0.2);
  doc.x = ML + 28;
  doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(body, { width: CONTENT_W - 28, lineGap: 2 });
  doc.x = ML;
  doc.moveDown(0.7);
}

function bullets(items) {
  doc.x = ML + 28;
  for (const it of items) {
    ensureSpace(20);
    const y = doc.y;
    doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(10).text("\u2022", ML + 28, y, { width: 12 });
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(it, ML + 42, y, { width: CONTENT_W - 42, lineGap: 1.5 });
    doc.moveDown(0.35);
  }
  doc.x = ML;
  doc.moveDown(0.3);
}

function note(label, text) {
  ensureSpace(50);
  const pad = 12;
  const textW = CONTENT_W - pad * 2 - 4;
  doc.font("Helvetica").fontSize(9.5);
  const h = doc.heightOfString(text, { width: textW, lineGap: 2 }) + pad * 2 + 14;
  const y = doc.y;
  doc.save();
  doc.roundedRect(ML, y, CONTENT_W, h, 6).fill(CREAM);
  doc.rect(ML, y, 4, h).fill(GOLD);
  doc.restore();
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(8.5).text(label.toUpperCase(), ML + pad, y + pad, { width: textW, characterSpacing: 1 });
  doc.fillColor(INK).font("Helvetica").fontSize(9.5).text(text, ML + pad, y + pad + 13, { width: textW, lineGap: 2 });
  doc.y = y + h + 12;
  doc.x = ML;
}

// ---------- Cover band ----------
doc.save();
doc.rect(0, 0, PAGE_W, 132).fill(NAVY);
doc.rect(0, 132, PAGE_W, 5).fill(GOLD);
doc.restore();
doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(11).text("WILLIAMS COUNCIL SECURITY GROUP", ML, 40, { characterSpacing: 2 });
doc.fillColor(CREAM).font("Helvetica-Bold").fontSize(24).text("Payroll & Invoicing Process", ML, 62);
doc.fillColor("#b9c0cc").font("Helvetica").fontSize(11).text("From approving officer time to processing payment \u2014 and how client invoices are populated", ML, 96, { width: CONTENT_W });

doc.y = 170;
doc.x = ML;
doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9.5)
  .text("SecureOps platform reference \u00b7 generated " + new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }), { width: CONTENT_W });
doc.moveDown(1.2);

// ---------- Overview ----------
doc.fillColor(INK).font("Helvetica").fontSize(10.5).text(
  "There are two connected money flows in SecureOps. PAYROLL pays officers for the hours they worked. INVOICING bills the client for those same hours at the client rate. Both are driven by one event: an admin approving a time entry. Approving time feeds the Payroll Board (what you pay officers) and, at the same moment, rebuilds that week's client invoice (what you bill the client).",
  { width: CONTENT_W, lineGap: 3 },
);
doc.moveDown(1);

// ============ PART 1 ============
sectionHeader(1, "Payroll - approving time to paying officers");

step(1, "Officer clocks in and out", "An officer clocks in (GPS-checked against the site) and clocks out on the mobile app. This creates a time entry with the actual hours worked. Open or zero-hour entries are ignored by payroll until completed.");

step(2, "Admin reviews and approves the time entry", "From the admin tools, an admin approves each entry (POST /time-entries/:id/approve, decision \"approved\"). Approval is the trigger for everything downstream - both the payroll figure and the client invoice. Rejecting an entry reverses both.");

step(3, "Approved hours land on the Payroll Board", "Approved entries are grouped into weekly payroll buckets. Each row shows the officer, the hours, the pay rate used, and the calculated gross. The board recomputes from the live entries every time you open it.");

doc.moveDown(0.1);
ensureSpace(40);
doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10.5).text("How the pay rate is chosen (highest priority first):", ML, doc.y, { width: CONTENT_W });
doc.moveDown(0.4);
bullets([
  "Admin override on the time entry (set via the board's \"Apply pay rate\" action) - wins over everything.",
  "The shift's pay rate (payRate on the posted shift).",
  "The officer's default hourly rate (on their employee record).",
  "If none of the above exist -> $0 with a warning so it is never paid silently.",
]);

note("Backfilling a missing rate", "From the Payroll Board you can select rows and apply a rate (POST /payroll/board/apply-rate). By default it only fills entries that currently resolve to $0, so wide selections are safe; you can uncheck that to force-overwrite. It refuses any entry already in a processed or paid batch - those numbers have already gone to the bank.");

step(4, "Open a Pay Run (Pending)", "Go to the Pay Run page. Selected payroll rows start in the PENDING state. Click Preview (POST /payroll/pay-run/preview) to see every row plus per-row warnings: missing bank account / routing number / account name, no direct-deposit consent, or a zero/negative net. Rows with warnings - and anything already paid - are excluded from the export so you never send a bad line to the bank.");

step(5, "Export the ACH/CSV batch (Pending" + ARROW + "Processed)", "Click Export CSV (POST /payroll/pay-run/export-csv). This downloads wcsg-payroll-<batch>.csv with employee name, account name, routing number, account number, amount, pay period, site, reference, and memo. In the same atomic step every payable row flips to PROCESSED, method ach_csv, tagged with the batch reference and the admin who ran it. Re-running is idempotent.");

step(6, "Upload the file to the bank", "Upload the exported CSV to your bank's ACH portal to actually move the money. (Stripe Connect payouts are wired in the schema but off until STRIPE_CONNECT_ENABLED is turned on.)");

step(7, "Confirm payment (Processed" + ARROW + "Paid)", "Once the bank confirms the transfer settled, mark the rows paid (POST /payroll/pay-run/mark-paid) with the bank's payment reference. Rows move to the final PAID state. This closes the loop and locks those numbers.");

note("Bank details source", "Direct-deposit data lives on the employee record (account name, account number, routing number) and requires directDepositConsent = true. Officers enter and confirm this during onboarding.");

// ============ PART 2 ============
doc.addPage();
sectionHeader(2, "Invoicing - how client invoices are populated");

doc.fillColor(INK).font("Helvetica").fontSize(10.5).text(
  "Invoices are built automatically from the very same approved time entries - you do not enter line items by hand. The system keeps one draft invoice per site per week and rebuilds it whenever time is approved for that week.",
  { width: CONTENT_W, lineGap: 3 },
);
doc.moveDown(0.9);

step(1, "Approving time auto-builds the invoice", "Every time you approve a time entry, the system finds-or-creates a DRAFT invoice for that entry's site and ISO week (week starts Monday 00:00 UTC). This is the same approval click from the payroll flow - one action feeds both.");

step(2, "Line items are rebuilt from approved hours", "The draft's line items are regenerated from every currently-approved entry in that week for that site (including ad-hoc geo clock-ins at the site). Lines are grouped per officer and per rate. Hours come from each entry's actual worked hours; open / zero-hour entries are skipped. Re-approving or rejecting re-syncs the draft - rejecting removes the line and deletes the draft if it becomes empty.");

doc.moveDown(0.1);
ensureSpace(40);
doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10.5).text("How the bill rate is chosen (highest priority first):", ML, doc.y, { width: CONTENT_W });
doc.moveDown(0.4);
bullets([
  "The shift's bill rate (billRate on the posted shift).",
  "The site's default bill rate (editable on the site record).",
  "If neither exists -> the invoice is refused with a \"no bill rate on file\" error so nothing is under-billed.",
]);

step(3, "Totals and due date", "Subtotal and total are summed from the line items. The due date is set to today plus the client's payment terms (Net X days, configured on the client record).");

step(4, "Manual edits take the invoice off auto-sync", "If an admin edits the billable fields (line items, subtotal, tax, total) via PUT /invoices/:id or the admin table, the invoice flips to auto_synced = false. From then on, later approvals for that week will not overwrite your hand-tuned numbers - they become your responsibility (logged as a warning).");

step(5, "Week-end locking", "An hourly job stamps locked_at on every draft whose week has ended. A late approval for an already-locked week does not touch the locked invoice - it creates a new adjustment draft for that same site + week, so historical bills stay intact.");

note("Why drafts are safe under load", "A partial unique index guarantees only one active auto-draft per site per week. If two approvals race, the loser re-reads the winner and re-applies the line items (latest tick wins, idempotent) - so concurrent approvals can never create duplicate invoices.");

step(6, "Manual generation (optional)", "You can also trigger a build directly (POST /invoices/generate with a site and week). It runs the exact same math, rates, and grouping as the automatic path - it is just a manual way to invoke the same engine.");

// ---------- Quick reference ----------
doc.addPage();
sectionHeader(3, "Quick reference - the two flows at a glance");

doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Payroll (what you pay officers)", ML, doc.y);
doc.moveDown(0.3);
doc.fillColor(INK).font("Helvetica").fontSize(10.5).text(
  "Clock in/out" + ARROW + "Admin approves time" + ARROW + "Payroll Board (rate resolved)" + ARROW + "Pay Run PENDING" + ARROW + "Preview (warnings filtered)" + ARROW + "Export CSV = PROCESSED" + ARROW + "Upload to bank" + ARROW + "Mark PAID.",
  { width: CONTENT_W, lineGap: 3 },
);
doc.moveDown(1);

doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Invoicing (what you bill the client)", ML, doc.y);
doc.moveDown(0.3);
doc.fillColor(INK).font("Helvetica").fontSize(10.5).text(
  "Admin approves time" + ARROW + "draft invoice found/created for site + week" + ARROW + "line items rebuilt from approved hours at the bill rate" + ARROW + "totals + due date set from client terms" + ARROW + "(edits take it off auto-sync)" + ARROW + "week-end lock; late approvals roll into an adjustment draft.",
  { width: CONTENT_W, lineGap: 3 },
);
doc.moveDown(1.2);

note("The single connecting point", "Approving a time entry is the one action that drives both flows. It is what pays the officer (via the Payroll Board) and what bills the client (via the auto-synced weekly invoice) - using the officer pay rate for payroll and the client bill rate for the invoice.");

// ---------- Footer on every page (no extra pages) ----------
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(range.start + i);
  doc.page.margins.bottom = 0; // prevent footer text near bottom from spawning a new page
  const fy = doc.page.height - 42;
  doc.save();
  doc.moveTo(ML, fy).lineTo(ML + CONTENT_W, fy).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.fillColor(MUTED).font("Helvetica").fontSize(8)
    .text("Williams Council Security Group \u00b7 SecureOps", ML, fy + 8, { width: CONTENT_W / 2, align: "left", lineBreak: false });
  doc.fillColor(MUTED).font("Helvetica").fontSize(8)
    .text("Page " + (i + 1) + " of " + range.count, ML + CONTENT_W / 2, fy + 8, { width: CONTENT_W / 2, align: "right", lineBreak: false });
  doc.restore();
}

doc.end();
stream.on("finish", () => {
  console.log("WROTE " + OUT + " (" + fs.statSync(OUT).size + " bytes)");
});
