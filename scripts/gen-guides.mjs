import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";

const NAVY = "#0c0a08";
const GOLD = "#b87333";
const CREAM = "#f0e4c0";
const INK = "#1c2433";
const MUTED = "#5b6472";
const RULE = "#d8cfb4";
const SUBTLE = "#b9c0cc";

const OUT_DIR = path.resolve(process.env.PDF_OUT_DIR || "exports");
fs.mkdirSync(OUT_DIR, { recursive: true });

/** Build a toolkit of layout primitives bound to a fresh LETTER document. */
function makeGuide(fileName, info) {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 64, bottom: 64, left: 64, right: 64 },
    bufferPages: true,
    info,
  });
  const outPath = path.join(OUT_DIR, fileName);
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const PAGE_W = doc.page.width;
  const ML = doc.page.margins.left;
  const CONTENT_W = PAGE_W - ML - doc.page.margins.right;

  function ensureSpace(h) {
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
  }

  function cover(kicker, title, subtitle, intro) {
    doc.save();
    doc.rect(0, 0, PAGE_W, 132).fill(NAVY);
    doc.rect(0, 132, PAGE_W, 5).fill(GOLD);
    doc.restore();
    doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(11).text(kicker, ML, 40, { characterSpacing: 2 });
    doc.fillColor(CREAM).font("Helvetica-Bold").fontSize(23).text(title, ML, 62, { width: CONTENT_W });
    doc.fillColor(SUBTLE).font("Helvetica").fontSize(11).text(subtitle, ML, 98, { width: CONTENT_W });
    doc.y = 170;
    doc.x = ML;
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9.5)
      .text("SecureOps platform guide \u00b7 generated " + new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }), { width: CONTENT_W });
    doc.moveDown(1.2);
    doc.fillColor(INK).font("Helvetica").fontSize(10.5).text(intro, { width: CONTENT_W, lineGap: 3 });
    doc.moveDown(1);
  }

  function sectionHeader(num, title) {
    ensureSpace(64);
    const y = doc.y + 6;
    doc.save();
    doc.roundedRect(ML, y, 30, 30, 6).fill(NAVY);
    doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(15).text(String(num), ML, y + 8, { width: 30, align: "center" });
    doc.restore();
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(15.5).text(title, ML + 42, y + 7, { width: CONTENT_W - 42 });
    doc.moveTo(ML, y + 36).lineTo(ML + CONTENT_W, y + 36).lineWidth(1.5).strokeColor(GOLD).stroke();
    doc.moveDown(1.1);
    doc.x = ML;
  }

  function step(n, title, body) {
    ensureSpace(50);
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
    doc.moveDown(0.6);
  }

  function bullets(items) {
    doc.x = ML + 28;
    for (const it of items) {
      ensureSpace(18);
      const y = doc.y;
      doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(10).text("\u2022", ML + 28, y, { width: 12 });
      doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(it, ML + 42, y, { width: CONTENT_W - 42, lineGap: 1.5 });
      doc.moveDown(0.32);
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

  function finish() {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0;
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
    return new Promise((res) => stream.on("finish", () => {
      console.log("WROTE " + outPath + " (" + fs.statSync(outPath).size + " bytes)");
      res();
    }));
  }

  return { doc, cover, sectionHeader, step, bullets, note, finish };
}

/* =====================================================================
   GUIDE 1 — OFFICER (EMPLOYEE) MOBILE APP
   ===================================================================== */
async function buildOfficerGuide() {
  const g = makeGuide("wcsg-officer-app-guide.pdf", {
    Title: "WCSG SecureOps - Officer Mobile App Guide",
    Author: "Williams Council Security Group",
    Subject: "How officers use the SecureOps mobile app",
  });

  g.cover(
    "WILLIAMS COUNCIL SECURITY GROUP",
    "Officer Mobile App Guide",
    "Everything you need to work your shifts from your phone",
    "This guide walks you through the SecureOps app as an officer: signing in, finding and accepting shifts, clocking in and out, filing reports, using the emergency button, and keeping your profile and pay information up to date. Your app has a bottom tab bar with Home, Shifts, Clock, Incidents, Chat, Profile, and Radio.",
  );

  g.sectionHeader(1, "Getting started");
  g.step(1, "Sign in", "Open the app and enter your email and the temporary password from your invite email. If two-factor (2FA) is turned on for your account, you'll also enter a 6-digit code from your authenticator app.");
  g.step(2, "Set your own password", "On your first sign-in you'll be asked to change your temporary password to one only you know. Choose something strong and private.");
  g.step(3, "Turn on Face ID / fingerprint (optional)", "After your first sign-in you can enable biometric unlock so you don't have to type your password every time.");
  g.note("Forgot your password?", "Tap \"Forgot password\" on the login screen to get a reset link by email. If you don't receive it, contact your administrator.");

  g.sectionHeader(2, "Your Home screen");
  g.step(1, "Check your status at a glance", "Home shows your week: hours worked, monthly hours, upcoming shifts, and any shifts waiting for you to accept.");
  g.step(2, "See if you're on duty", "If you're clocked in, a green \"ON DUTY\" banner appears with a shortcut to the Clock tab. If not, you'll see a Clock In button.");
  g.step(3, "Watch for alerts", "Red banners warn you about expired or missing licenses and open incidents that need your attention. Quick-action shortcuts let you jump straight to Report Incident, My Shifts, or My Profile.");

  g.sectionHeader(3, "Finding and managing shifts");
  g.step(1, "Browse available work", "On the Shifts tab, the Available filter shows open slots you qualify for. Tap \"Reserve Slot\" to book one. The app warns you if the site is more than 50 miles from your home address.");
  g.step(2, "Accept or decline assignments", "Shifts an admin assigns to you appear as \"Pending.\" Tap Accept to commit, or Decline to release the slot so someone else can take it.");
  g.step(3, "Request a swap", "For an upcoming shift you can't make, open it and tap \"Request Swap.\" Track incoming and outgoing swap requests on the Swap Requests screen \u2014 accept, decline, or cancel as plans change. Swaps still need admin approval.");
  g.note("Clock-in shortcut", "A \"Clock In Now\" button appears on your upcoming/active shift about 1 hour before it starts.");

  g.sectionHeader(4, "Clocking in and out");
  g.step(1, "Enable location", "Make sure GPS/location is on \u2014 the app uses it to confirm you're at the right site.");
  g.step(2, "Clock in", "On the Clock tab, tap the large green CLOCK IN button. The app finds your site from your GPS location; confirm the prompt. A timer starts and a green \"ON DUTY\" ring appears.");
  g.step(3, "Stay tracked while on duty", "While clocked in, the app quietly updates your location about once a minute so dispatch can see you on the live map. If you drift outside the site perimeter, your admins are alerted.");
  g.step(4, "Clock out", "When your shift ends, tap the red CLOCK OUT button and confirm. Your hours are then sent to an admin for approval.");

  g.sectionHeader(5, "Filing an incident report");
  g.step(1, "Open the form", "On the Incidents tab, tap the + button.");
  g.step(2, "Describe what happened", "Enter a title and location, choose a severity (Low, Medium, High, Critical), then write a clear description and the actions you took.");
  g.step(3, "Add photos", "Capture live photos with \"Take Photo\" or attach existing ones from your library.");
  g.step(4, "Submit and follow up", "Tap Submit Report. You can review your past reports and read any resolution notes an admin adds later.");

  g.sectionHeader(6, "Emergency button");
  g.step(1, "Press and hold for 3 seconds", "On the Home screen, press and hold the red \"HOLD 3s FOR EMERGENCY\" button. A fill bar shows your progress.");
  g.step(2, "Help is alerted instantly", "Releasing after 3 seconds silently alerts all admins with your GPS location and raises a critical incident.");
  g.step(3, "Call for help", "The app then offers a one-tap button to dial 911 (or your company's configured emergency number).");
  g.note("Accessibility", "With a screen reader active, the emergency control switches to a double-tap action so it's still easy to trigger.");

  g.sectionHeader(7, "Daily reports and patrols");
  g.step(1, "Daily Activity Report (DAR)", "At the end of a shift, open the DAR screen, fill in your summary, visitor and patrol counts, weather, and any observations, type your name as a signature, then tap Submit report.");
  g.step(2, "Patrol checkpoint scans", "At a checkpoint, open the Patrol screen, enter the checkpoint code (from the QR/NFC tag), and tap Log scan. The app confirms you're at the correct site and clocked in.");

  g.sectionHeader(8, "Communication \u2014 Chat and Radio");
  g.step(1, "Chat", "The Chat tab lists your channels and direct messages. Tap any room to send and receive messages in real time with your team and admins.");
  g.step(2, "Radio (Push-to-Talk)", "On the Radio tab, pick a channel (Global, site-specific, etc.) to monitor who's transmitting. On web, hold the microphone button to talk; native push-to-talk audio is coming in a future update.");

  g.sectionHeader(9, "Your profile, pay, and compliance");
  g.step(1, "View your profile", "The Profile tab shows your pay rate, license level, contact info, banking details, documents, and a \"Recent Updates\" history of changes HR made.");
  g.step(2, "View paystubs", "From your profile, open My Paystubs to see year-to-date gross and net, plus each paystub with a breakdown of hours, rate, gross, and tax.");
  g.step(3, "Set your availability", "On the Availability screen, set your max hours per week and add time windows per day. The app then suggests open shifts that fit your windows.");
  g.step(4, "Keep your details current", "Use Edit Profile to update phone, address, emergency contacts, and uniform sizes. Sensitive changes (like banking) automatically notify HR.");
  g.step(5, "Renew licenses and add training", "If a license is expiring, use License Renewal to upload a photo of your new card and its expiry date. Use Training to add new certifications (e.g., CPR, First Aid) for admin verification.");

  return g.finish();
}

/* =====================================================================
   GUIDE 2 — ADMIN MOBILE APP
   ===================================================================== */
async function buildAdminMobileGuide() {
  const g = makeGuide("wcsg-admin-app-guide.pdf", {
    Title: "WCSG SecureOps - Admin Mobile App Guide",
    Author: "Williams Council Security Group",
    Subject: "How admins use the SecureOps mobile app",
  });

  g.cover(
    "WILLIAMS COUNCIL SECURITY GROUP",
    "Admin Mobile App Guide",
    "Run operations from your phone \u2014 personnel, shifts, time, and live ops",
    "This guide covers the SecureOps app for administrators: monitoring the dashboard, managing personnel and shifts, approving time, running payroll and invoices, handling incidents, and tracking officers live. For deeper back-office work (HR pipeline, bulk imports, exports), use the web Admin Portal \u2014 covered in its own guide.",
  );

  g.sectionHeader(1, "Dashboard \u2014 your operations hub");
  g.step(1, "Read the operational status", "The dashboard shows live counts: active shifts, officers clocked in, open incidents, upcoming shifts, total staff, and expiring licenses. Tap any card to jump to that area.");
  g.step(2, "Fill open vacancies", "A list shows upcoming shifts that still need officers. Tap \"Notify\" to push a request to every qualified officer, or tap a vacancy to open the shift and assign someone by hand.");
  g.step(3, "Scan recent incidents", "A feed of the latest incidents is color-coded by severity so critical items stand out. Quick actions link to Clients, Time Approval, Payroll, Invoices, and Licenses.");

  g.sectionHeader(2, "Personnel management");
  g.step(1, "Find people", "On Personnel, search by name or email and filter by status (All, Active, Inactive, Pending). Badges show who's online now and who's new (joined in the last 7 days).");
  g.step(2, "Add an employee", "Tap + to open Add Employee. Enter personal details, set the role (Admin or Employee), assign an hourly rate, and list skills.");
  g.step(3, "Manage a profile", "Open an officer to see contact info, emergency contacts, banking details, and licenses. Tap Edit to update details and pay rate, or use the status toggle to activate/deactivate them.");

  g.sectionHeader(3, "Posting and assigning shifts");
  g.step(1, "Browse shifts", "On Shifts, filter by Upcoming, Active, Completed, or Cancelled.");
  g.step(2, "Post a new shift", "Tap + to open Post New Shift. Pick a client and site, set a title, headcount, and required license level (L2, L3, or L4/PPO), enter start/end times, choose whether it repeats, and set the officer pay rate and client bill rate.");
  g.step(3, "Assign personnel", "Open a shift to see assigned officers. Add qualified officers from the list with +, or remove someone with the X. Posting a shift automatically notifies all qualified officers.");

  g.sectionHeader(4, "Approving time");
  g.step(1, "Review entries", "On Time Approval, filter by Pending, Approved, or Rejected. Each entry shows logged hours against clock-in/out times for the site and shift.");
  g.step(2, "Adjust if needed", "In the \"Approve hours\" field you can override the logged hours \u2014 for example, if an officer forgot to clock out.");
  g.step(3, "Approve or reject", "Tap Approve to finalize the entry or Reject to decline it. Approving feeds both payroll and the client invoice automatically.");

  g.sectionHeader(5, "Payroll and invoices");
  g.step(1, "Generate payroll", "On Payroll, pick a site and the week-starting date, then tap \"Generate from Approved Hours\" to calculate gross/net pay for every officer at that site. Toggle individual entries between Pending and Paid.");
  g.step(2, "Manage invoices", "On Invoices, filter by Draft, Sent, Paid, or Overdue. Pick a site and week and tap \"Generate Invoice for Week\" to bill the client, then mark drafts Sent and received payments Paid.");
  g.note("Tip", "For full payroll execution (ACH/CSV export and bank reconciliation), use the web portal's Pay Run \u2014 see the Payroll & Invoicing Process document.");

  g.sectionHeader(6, "Incidents");
  g.step(1, "Monitor alerts", "On Incidents, filter by Open, Under Review, Resolved, or Closed. Critical incidents carry a red badge.");
  g.step(2, "Review the detail", "Tap an incident to read the description, the officer's actions taken, and any attached photos. You can jump straight to the reporting officer's profile.");
  g.step(3, "Resolve it", "Add admin resolution notes and move the status forward (Open \u2192 Under Review \u2192 Resolved).");

  g.sectionHeader(7, "Live map and tracking");
  g.step(1, "See who's out there", "Live Map shows the location of every officer currently clocked in, refreshing automatically.");
  g.step(2, "Check officer status", "A list shows each active officer, their shift/site, and when they were last seen. Tap \"Maps\" to open their coordinates in Google Maps.");

  g.sectionHeader(8, "Clients, sites, and licenses");
  g.step(1, "Manage clients and sites", "On Clients, add a client with contact info and payment terms (e.g., Net 30). Open a client to manage its sites; tap + to add a physical location with its address and on-site contact.");
  g.step(2, "Track licenses", "On Licenses, view all officer licenses and filter by Expiring or Expired. Tap + to record a new license with its type, number, level, and expiry date.");

  g.sectionHeader(9, "Communication \u2014 Chat and Radio");
  g.step(1, "Chat", "Create public channels or start a direct message with any employee for real-time coordination.");
  g.step(2, "Radio", "Pick a channel (Global, Admins, or site-specific) and monitor who's transmitting. Live audio is currently optimized for the web portal; native push-to-talk is planned.");

  return g.finish();
}

/* =====================================================================
   GUIDE 3 — ADMIN WEB PORTAL
   ===================================================================== */
async function buildAdminPortalGuide() {
  const g = makeGuide("wcsg-admin-portal-guide.pdf", {
    Title: "WCSG SecureOps - Admin Web Portal Guide",
    Author: "Williams Council Security Group",
    Subject: "How admins use the SecureOps web portal",
  });

  g.cover(
    "WILLIAMS COUNCIL SECURITY GROUP",
    "Admin Web Portal Guide",
    "The full command center \u2014 HR, dispatch, accounting, and compliance",
    "The Admin Portal is the web command center for SecureOps. It uses a two-tier menu: top tabs group everything into Dispatch, Personnel Management, Accounting, Security, Operations, and Settings; the sidebar then lists the pages inside the selected group. A banner at the top flags any critical configuration issues (such as missing email or an insecure session secret).",
  );

  g.sectionHeader(1, "Signing in and navigating");
  g.step(1, "Log in", "Enter your email and password. If two-factor is enabled, you'll then enter a TOTP code or a recovery code.");
  g.step(2, "Find your way around", "Use the top tabs to choose a work area, then the sidebar to open a specific page. Watch the top banner for configuration warnings.");
  g.step(3, "Secure your account", "Under Settings \u2192 My 2FA, set up or reset your own two-factor authentication.");

  g.sectionHeader(2, "HR pipeline \u2014 applicant to active officer");
  g.step(1, "Public application", "Candidates apply through the public Apply page (personal details, licenses, document uploads). You can share this link directly.");
  g.step(2, "Review applications", "On Applications, search and filter submissions, then open one to Approve, Reject, or Request more info. Requesting info emails the applicant an amendment link to fix specific fields via the Amend page \u2014 no full resubmission needed.");
  g.step(3, "Approve", "Approving automatically creates the user and employee record and generates a temporary password, then issues an onboarding link.");
  g.step(4, "Onboarding", "Onboarding tracks approved candidates who still need to finish their profile (bank details, tax, uniform sizes, policy signatures). Resend the link if it expires.");
  g.step(5, "Invitations", "Use Invitations to generate temporary passwords in bulk and email sign-in invites \u2014 useful for staff who skip the public form. Admins are never targeted by bulk actions.");

  g.sectionHeader(3, "Personnel and compliance");
  g.step(1, "Personnel roster", "See your whole roster, with on-duty officers highlighted by a live green pulse and last-ping time. Click an officer to open their full profile \u2014 contact info, documents, and live GPS location.");
  g.step(2, "Compliance check", "On Compliance, select a site to see which officers are compliant versus which have gaps (e.g., missing First Aid or firearms training) against that site's requirements.");
  g.step(3, "License renewals", "Work the License Renewals queue to review and verify expiring security licenses.");

  g.sectionHeader(4, "Dispatch and staffing");
  g.step(1, "Dispatch command center", "The live-ops hub combines a real-time map of clocked-in officers and active incidents, a live incident list (click to add notes or change status), and an Open Shifts panel for the next 72 hours.");
  g.step(2, "Assign nearest", "On an open shift, use \"Assign Nearest\" to see qualified officers ranked by distance and assign one with a single click.");
  g.step(3, "Plan staffing", "Use Staffing's calendar view to manage events and shifts, including repeating shift series for long-term contracts.");
  g.step(4, "Approve swaps", "Review and approve shift trades between officers on Swap Requests.");

  g.sectionHeader(5, "Time, payroll, and invoicing");
  g.step(1, "Approve time", "Review and approve or reject clock-in/out records. Approval drives both payroll and invoicing.");
  g.step(2, "Payroll Board and Pay Run", "The Payroll Board summarizes pending pay; from there run a Pay Run to preview, export the ACH/CSV batch, and mark officers paid.");
  g.step(3, "Invoice Board", "Client invoices are auto-built from approved hours at each site's bill rate. Track Draft, Sent, and Paid statuses and generate or adjust as needed.");
  g.note("Deep dive", "The end-to-end payroll and invoice logic is documented separately in the \"Payroll & Invoicing Process\" PDF.");

  g.sectionHeader(6, "Operations \u2014 data management");
  g.step(1, "Generic tables", "The Operations tables manage core data (Clients, Sites, Shifts, Users). Search, filter, and add or edit rows through dynamic dialogs.");
  g.step(2, "Bulk import", "Use the Import Wizard to upload spreadsheets (.xlsx) and map columns to the right fields for bulk creation.");
  g.step(3, "Site detail", "Open a site from the Sites table to see its parent client, all its shifts and assigned staff, and to set a custom geofence radius overriding the global default.");

  g.sectionHeader(7, "Communication, reports, and sharing");
  g.step(1, "Chat and Radio", "Message individuals or groups in real time on Chat, and use Radio for push-to-talk style voice transmissions.");
  g.step(2, "Daily reports", "Daily Reports is a searchable archive of the DARs officers submit at the end of their shifts.");
  g.step(3, "Secure share links", "Generate expiring, no-login links to share a specific incident or employee profile with outside parties (e.g., a client manager or insurance adjuster).");

  g.sectionHeader(8, "Security, audit, and exports");
  g.step(1, "Audit log", "Under Security, search the audit log to see every privileged change \u2014 who did what, and when.");
  g.step(2, "System status", "The configuration banner and security settings surface missing email/SMTP, weak session secrets, and other deployment requirements.");
  g.step(3, "Exports", "Use Exports to pull data out of the system for reporting or record-keeping.");

  return g.finish();
}

await buildOfficerGuide();
await buildAdminMobileGuide();
await buildAdminPortalGuide();
console.log("DONE");
