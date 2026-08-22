/**
 * Curated portal how-to knowledge base.
 *
 * Deliberately plain TypeScript string modules rather than markdown files read
 * from disk: esbuild bundles the api-server into a single dist file, so any
 * runtime `fs` path to a repo-relative doc silently disappears in production.
 *
 * Everything here is written and reviewed by a human. The model is instructed
 * to answer ONLY from the articles it is given and to decline otherwise — a
 * confidently wrong instruction about payroll is worse than "I don't know".
 * When you change a workflow in the portal, update the matching article.
 *
 * Type-only import of FeatureKey on purpose: this module stays dependency-free
 * so the admin-portal coverage test can import it across the artifact boundary.
 * The enabled/disabled decision is made by the caller (see `retrieveArticles`).
 */

import type { FeatureKey } from "@workspace/feature-keys";

export type KbArticle = {
  id: string;
  title: string;
  /** Extra words that should match this article but don't appear in the body. */
  keywords: string[];
  /**
   * The optional feature this article's subject depends on. When it is
   * switched off for the company, the article is withheld and the assistant
   * says the feature is not enabled instead of describing pages that are not
   * in that person's sidebar. Articles about always-on parts of the portal
   * (shifts, sites, time entries, permissions, audit log) declare nothing.
   *
   * One article, one subject, one feature: if an article would need two keys,
   * split it, or a tenant with only one of the two gets told something false.
   */
  feature?: FeatureKey;
  /** Portal route the reader should end up on, if there is a single obvious one. */
  route?: string;
  /**
   * Other portal routes this article explains well enough to count as their
   * documentation. `route` counts automatically — list only the extras.
   *
   * This is what ties the knowledge base to the real portal: the admin-portal
   * test `assistantKbCoverage.test.ts` fails when a nav entry or route is not
   * claimed here (or listed in KB_ROUTES_WITHOUT_ARTICLE), and when a route
   * claimed here no longer exists.
   */
  alsoCovers?: readonly string[];
  body: string;
};

export const KB_ARTICLES: readonly KbArticle[] = [
  {
    id: "run-payroll",
    title: "Running payroll",
    keywords: ["pay", "paycheck", "pay run", "wages", "1099", "pay period", "paystub"],
    feature: "payroll",
    route: "/payroll/pay-run",
    alsoCovers: ["/payroll/board", "/payroll/time-card", "/tables/payroll_entries"],
    body: [
      "Payroll is built from APPROVED time entries only. An entry that is still pending approval is never paid.",
      "",
      "1. Open Accounting > Time Cards to review the week and fix any bad clock times. Corrections here are recorded in the entry's change history.",
      "2. Open Accounting > Payroll Board. It buckets approved hours by officer for the payroll week (weeks run Monday to Sunday in the company's local business timezone, not UTC).",
      "3. Approve any outstanding time entries first — Staffing > Time Entries, or from the officer's time card. Approving an entry is what makes it billable and payable.",
      "4. Open Accounting > Pay Run. Review the per-officer totals, then export the CSV. The export atomically claims the rows it exports, so the same approved hours can never be exported into two pay runs.",
      "5. Mark the run paid once the money has actually gone out.",
      "",
      "Every worker on this platform is a 1099 contractor, so payroll never withholds tax — net pay always equals gross pay. If you are seeing a tax line, that is a bug worth reporting.",
      "",
      "Pay rate for an officer resolves in this order: a per-assignment override, then the officer's profile rate, then the shift's rate. A rate of zero counts as 'not set', not as 'free'.",
    ].join("\n"),
  },
  {
    id: "approve-time-entries",
    title: "Approving time entries",
    keywords: ["approve", "timesheet", "time card", "clock in", "clock out", "hours", "verify"],
    route: "/tables/time_entries",
    body: [
      "A time entry has to be clocked out before it can be approved — there is no approving an open shift.",
      "",
      "1. Go to Staffing > Time Entries, or Accounting > Time Cards for a per-officer weekly view.",
      "2. Check the clock-in and clock-out times. You can correct them; the original values and who changed them are kept in the entry's history.",
      "3. Approve or reject. Approving sets the entry verified and releases it to payroll.",
      "",
      "Approving also folds the hours into that site's weekly draft client invoice. Rejecting an entry that was previously approved pulls it back out of the draft again.",
      "",
      "Site managers can only approve entries at sites they manage. Admins are unscoped.",
      "",
      "If an officer never confirms their own entry, an approval from an admin clears the awaiting-confirmation state so payroll is not blocked.",
    ].join("\n"),
  },
  {
    id: "create-shift",
    title: "Creating a shift",
    keywords: ["schedule", "roster", "post a shift", "new shift", "recurring", "repeat"],
    route: "/shifts",
    body: [
      "1. Go to Staffing > Shifts and use New Shift.",
      "2. Pick the site first. The client name, address and the site's default pay and bill rates are filled in from the site record.",
      "3. Set the start and end time, the required licence level, and how many officers you need (headcount).",
      "4. Save. Officers who are eligible for that licence level can then claim it, or you can assign someone directly.",
      "",
      "A shift can only be posted against an ACTIVE site. Reactivate the site first if it has been retired.",
      "",
      "Site managers can only post shifts at sites they manage, and their shifts inherit the site's default rates — they do not see or set rates themselves.",
      "",
      "For a recurring post, use the repeat option rather than creating each day by hand. Note that a recurring shift shows up on every day it repeats, which is the usual reason a roster looks like it has more open shifts than expected.",
    ].join("\n"),
  },
  {
    id: "assign-officer",
    title: "Assigning an officer to a shift",
    keywords: ["assign", "staff a shift", "roster", "claim", "cover", "put on"],
    route: "/shifts",
    alsoCovers: ["/tables/shift_assignments"],
    body: [
      "Open the shift from Staffing > Shifts and add the officer to its roster, or use the Dispatch board to fill an open post.",
      "",
      "Three guards apply and they are not optional:",
      "- Licence level: the officer must hold the level the shift requires. Admins and dispatchers can override this deliberately for a judgement call, and the override is recorded in the audit log.",
      "- Double-booking: an officer already on an overlapping shift is refused.",
      "- Headcount: once the shift is full, further assignments are refused.",
      "",
      "An assignment an admin creates is issued as pending for the officer to accept. An officer can accept a shift offered to them, but can never approve their own claim on a shift.",
      "",
      "Site managers can only assign officers at sites they manage.",
    ].join("\n"),
  },
  {
    id: "add-site",
    title: "Adding a site and setting its rates",
    keywords: ["site", "location", "post", "venue", "bill rate", "pay rate", "client site"],
    route: "/tables/sites",
    alsoCovers: ["/tables/clients"],
    body: [
      "1. Add the client first under Clients & Sites > Clients if they are not already there.",
      "2. Go to Clients & Sites > Sites and add the site against that client, with its address and map coordinates. The coordinates are what geofenced clock-in checks against.",
      "3. Set the site's default pay rate and default bill rate. Do this before any shifts are worked there.",
      "",
      "The default bill rate matters more than it looks. If an approved time entry has no shift-level rate and the site has no default bill rate, those hours are silently left off the client invoice — the work is done, recorded, and never billed. Any site with recent shifts and no resolvable bill rate should be treated as a live billing leak.",
      "",
      "Retiring a site: setting it inactive only blocks NEW shifts. Existing shifts, clock-ins and payroll keep working. Deleting a site is different and destructive — some dependent records are detached and others are deleted outright.",
    ].join("\n"),
  },
  {
    id: "hire-and-invite-staff",
    title: "Hiring someone and getting a staff account created",
    keywords: ["invite", "new user", "staff account", "onboarding", "hire", "applicant", "signup", "temporary password", "login"],
    feature: "hr",
    route: "/hr/invitations",
    alsoCovers: ["/hr/applications", "/hr/onboarding"],
    body: [
      "For a new officer coming through hiring: Personnel Management > Applications, review and approve the application, then provision their account. Being approved is not the same as having an account — the account is created in a separate step, and until then they cannot log in.",
      "",
      "For someone you are adding directly: Personnel Management > Invitations sends an invite with a temporary password. They must change it at first login before they can use anything else.",
      "",
      "Personnel Management > Onboarding tracks people who have an account but have not finished their paperwork.",
    ].join("\n"),
  },
  {
    id: "client-logins-and-app-invite",
    title: "Client portal logins and connecting the mobile app",
    keywords: ["client user", "client login", "client portal", "qr code", "organisation code", "org code", "connect app", "mobile app"],
    route: "/hr/client-users",
    alsoCovers: ["/settings/invite"],
    body: [
      "For a client contact who should see their own schedules, reports and invoices, use Clients & Sites > Client Users. That is a client-portal login, not a staff account, and it can never be put on a shift roster.",
      "",
      "Platform > App Invite gives you the QR code and organisation code officers need to connect the mobile app to this company.",
    ].join("\n"),
  },
  {
    id: "application-form-builder",
    title: "Configuring the job application form",
    keywords: [
      "application form", "apply", "form builder", "custom question", "public form", "hiring form",
    ],
    feature: "hr",
    route: "/hr/application-builder",
    body: [
      "Personnel Management > Application Builder controls the public form candidates fill in. It is configuration whose effect shows up somewhere else, so nothing you do here looks like anything until a candidate opens the form.",
      "",
      "- The built-in questions are a fixed set inside fixed sections. You can rename them, change their help text, make them required or optional, hide them, and reorder them within their own section. First name, last name, email, phone and address are locked: always asked, always required, rename and help text only.",
      "- Custom questions are yours to add — short and long text, number, date, single-select, multi-select, yes/no, file and photo. A select question needs its options one per line.",
      "- There is no draft or publish step. Every change saves as you make it, and the next candidate to open the form gets it.",
      "- Deleting a custom question stops it being asked but does not erase the answers already given. Each submitted answer is kept with the label it was asked under, so renaming or removing a question never rewrites what an old applicant appears to have said.",
      "",
      "Because there is no publish step, restructuring the live form part-way through a hiring push changes the form under anyone who is mid-application. Required is enforced on the server, not only in the browser, so an application missing a field you have just made required is refused outright rather than saved half-finished. Make structural changes when the pipeline is quiet.",
    ].join("\n"),
  },
  {
    id: "policies-and-acknowledgements",
    title: "Policy documents and acknowledgements",
    keywords: ["policy", "policies", "handbook", "acknowledge", "signed document", "version"],
    feature: "policies",
    route: "/hr/policies",
    body: [
      "Personnel Management > Policies holds the documents people have to accept.",
      "",
      "- A policy is a label plus a PDF. Uploading a replacement does not edit the document in place: it creates the next version, makes that one active and keeps the previous one, because every acknowledgement is pinned to the exact version that was signed.",
      "- Every ACTIVE policy that has a document attached must be acknowledged. That happens during onboarding, and in the mobile app for staff who already have accounts — not on the public application form, so adding a policy does not make the application longer.",
      "- Who has and has not signed is visible under Personnel Management > Onboarding and in Personnel Management > Employee Reports. The policies page itself lists the documents and their versions, not a per-person matrix.",
      "",
      "A policy that has been signed cannot be deleted — deactivate it instead, so the signatures stay as evidence of what was agreed and when. Replacing a PDF while somebody is part-way through onboarding invalidates the version they were reading, and they are asked to read the new one before they can submit.",
    ].join("\n"),
  },
  {
    id: "licence-renewals",
    title: "Reviewing licence renewals",
    keywords: ["renewal", "renew", "expiring licence", "expiring license", "reminder", "review queue"],
    feature: "licenseRenewals",
    route: "/hr/license-renewals",
    body: [
      "Officers submit a renewal from the mobile app: a photo of the new licence and its new expiry date. It arrives as a review queue in Compliance & Training > License Renewals.",
      "",
      "1. Open the photo and check it against the licence number and expiry date submitted, then approve or reject. A rejection needs a reason, and the officer is sent it.",
      "2. Approving writes the new expiry onto the licence record and restarts the reminder cycle. Reminders are automatic — email and push at 60, 30, 14 and 7 days before expiry — so there is no 'send a reminder' button to hunt for.",
      "3. For a renewal that arrived on paper, or to correct a record, edit it directly in Compliance & Training > Licences.",
      "",
      "Approving a renewal updates both places licence data lives, which editing the employee record alone does not.",
      "",
      "A renewal sitting unreviewed close to an expiry date is urgent, not paperwork: the day a licence expires the officer's level drops by itself, and they can be turned away at clock-in on a shift they were rostered for weeks ago.",
    ].join("\n"),
  },
  {
    id: "licences-and-compliance",
    title: "Licence levels, records and the compliance rollup",
    keywords: [
      "licence", "license", "expiry", "expired", "sia", "compliance", "level", "certification",
      "eligible", "blocked",
    ],
    route: "/compliance",
    alsoCovers: ["/tables/licenses"],
    body: [
      "An officer's licence level is calculated from their UNEXPIRED licence records only, and that level is what decides which shifts they can work. Level 1 support posts need no licence; anything above that needs a current licence at that level or higher. The day a licence expires the officer's level drops by itself — nobody has to deactivate anything.",
      "",
      "Compliance & Training > Licences is the record grid behind that; Compliance & Training > Compliance is the standing overview: for each active officer, their current licence level, any training their sites require that they do not hold, and certificates expiring within 30 days.",
      "",
      "Licence data lives in two places: the licence records that eligibility actually reads, and the licence summary on the employee record that the officer profile and the profile PDF print. Editing through the Licences grid keeps both in step. Editing the licence fields on the employee record alone does not — the profile then looks current while the officer stays blocked, which is the most confusing failure on this page.",
      "",
      "Expiry is checked when a shift is claimed AND again at clock-in, so an officer rostered weeks ago can be turned away on the day.",
      "",
      "Admins and dispatchers can override the licence check when assigning someone manually, and the override is recorded in the audit log. There is no override for an officer claiming a shift themselves or clocking in — for those the licence has to be genuinely current.",
      "",
      "A green light on the rollup means the officer holds a valid licence and is not missing a site-required training. It does not mean they meet the level that any particular shift asks for.",
    ].join("\n"),
  },
  {
    id: "generate-invoice",
    title: "Generating and sending a client invoice",
    keywords: ["invoice", "bill", "billing", "client charge", "receivable", "send invoice"],
    feature: "invoicing",
    route: "/invoices/board",
    alsoCovers: ["/tables/invoices"],
    body: [
      "Invoices build themselves from approved time entries. Approving an entry adds its hours to that site's weekly draft invoice, so most of the work is really time-entry approval.",
      "",
      "1. Go to Accounting > Invoice Board and open the draft for the site and week.",
      "2. Check the unpriced-hours warning. Hours with no resolvable bill rate are NOT on the invoice — fix the site's bill rate, regenerate, and void the short draft rather than sending it.",
      "3. Preview the invoice. Sending requires a preview first: the preview issues a single-use ticket, so you always see the exact PDF that goes out and cannot accidentally send twice.",
      "4. Send. Marking an invoice sent by hand is not a way around the preview step.",
      "",
      "Three different email addresses are involved and they get confused a lot: the contact address printed in the invoice body comes from the brand billing email, the From address comes from the mail provider configuration, and replies go to the reply-to address.",
      "",
      "Turning on the processing fee only affects invoices created afterwards. Existing invoices, including drafts, keep their original figures until you recalculate them individually.",
    ].join("\n"),
  },
  {
    id: "pay-subcontractors",
    title: "Paying subcontractors (the subcontractor pay run)",
    keywords: [
      "subcontractor", "vendor", "supplier", "accounts payable", "ach", "bank transfer",
      "vendor invoice", "payout", "batch", "mark paid",
    ],
    route: "/subcontractors/pay-run",
    body: [
      "This is not officer payroll and the payroll steps do not apply to it. Officer payroll pays approved TIME ENTRIES and works the money out from hours and rates. The subcontractor pay run pays approved VENDOR INVOICES: the amount is whatever the invoice says, and no hours are recalculated here.",
      "",
      "1. Approve the invoice first. That happens on the record grid, Contracts > Invoices, not on the pay run. Only invoices in status approved are payable — draft, pending and rejected rows are never paid.",
      "2. Open Contracts > Subcontractor Pay Run. It lists the approved invoices grouped by vendor. There is no pay-period picker: the period is whatever the invoices themselves cover, so scoping a run to a month is a matter of which invoices you approve.",
      "3. Select the rows — one at a time, a whole vendor, or everything — and preview. The preview gives you the total, how many of the selected rows are actually payable, and the warnings on the rest.",
      "4. Export the ACH CSV and give that file to the bank. The export atomically claims the rows it exports and moves them to processed, so the same invoice can never appear in two payment files; a second, concurrent export is refused rather than duplicated.",
      "5. When the bank confirms the money has gone, come back and mark the invoices paid with the payment reference. Marking paid only accepts invoices that are approved or processed, so one already paid cannot be paid again.",
      "",
      "The trap is the silent exclusion. A selected row that has any warning is left out of the CSV and the export still succeeds, so the file can quietly be short. The warnings come from the VENDOR record rather than the invoice: missing bank account name, account number or routing number, direct-deposit consent not on file, or a total of zero. Compare the payable count in the preview against the number of rows you selected, and fix the vendor under Contracts > Subcontractors before exporting again.",
      "",
      "Marking paid also works on an approved invoice that was never exported. That is right for a cheque or a manual transfer, but it means an invoice can be settled with no payment file behind it — use it deliberately.",
      "",
      "Stripe payouts are scaffolded and switched off. The button is visible and will refuse until an operator enables and configures it.",
    ].join("\n"),
  },
  {
    id: "incidents-and-shares",
    title: "Incidents and sharing an incident report with a client",
    keywords: ["incident", "report", "share link", "client report", "escalation"],
    feature: "incidents",
    route: "/tables/incidents",
    alsoCovers: ["/incidents/share-links"],
    body: [
      "Incidents are filed by officers from the mobile app and land in Dispatch > Incidents.",
      "",
      "To give a client an incident report, use Dispatch > Incident shares to create a share link rather than emailing a PDF by hand. The link is scoped to that one incident, is tracked, and can be revoked.",
    ].join("\n"),
  },
  {
    id: "daily-activity-reports",
    title: "Daily activity reports",
    keywords: ["dar", "daily activity", "daily report", "end of shift", "proof of coverage"],
    feature: "dar",
    route: "/dar",
    body: [
      "Daily activity reports are the routine end-of-shift deliverable — Dispatch > Daily Reports. They are what most clients expect to receive as proof of coverage.",
      "",
      "Officers file one from the mobile app at the end of a shift, and it becomes the record of what happened on post.",
    ].join("\n"),
  },
  {
    // Patrol is its own plan feature, so it cannot ride along in the daily
    // report article: a company can have reports without checkpoints.
    id: "patrol-checkpoints",
    title: "Patrol checkpoints and proof of rounds",
    keywords: ["patrol", "checkpoint", "rounds", "scan", "proof of patrol", "walked"],
    feature: "patrol",
    route: "/tables/sites",
    body: [
      "Checkpoints are defined on the site itself — Clients & Sites > Sites — and officers scan them from the mobile app as they walk their rounds.",
      "",
      "The scan record is the evidence that the patrol actually happened, which is what turns 'the officer says they walked the rounds' into something you can put in front of a client who is questioning coverage.",
    ].join("\n"),
  },
  {
    id: "permissions-and-roles",
    title: "Roles, permissions and who can see money",
    keywords: ["permission", "role", "access", "dispatcher", "site manager", "bookkeeper", "company owner"],
    route: "/settings/permissions",
    alsoCovers: ["/settings/company-owners"],
    body: [
      "There are two separate access systems and they do different jobs.",
      "",
      "Platform > Permissions is the per-role matrix: which roles may create shifts, approve time, manage personnel, use the dispatch board, or handle invoice and payroll transactions. Admins always keep every permission and cannot be locked out.",
      "",
      "The company-owner flag is separate and only controls the aggregate financial dashboards — total revenue, company-wide payroll. Someone can be given transactional finance access (open and edit an individual invoice) without ever seeing company totals. That is how you set up a bookkeeper.",
      "",
      "Site managers are scoped by site. Every scheduling or time action they take is checked against the sites they actually manage. On their own pay they behave like an officer — they see their own paystubs, never anyone else's and never client financials.",
      "",
      "Officers who sign into the admin portal by mistake are sent to the main app instead of being dead-ended.",
    ].join("\n"),
  },
  {
    id: "audit-log",
    title: "Finding out who changed something",
    keywords: ["audit", "history", "who changed", "log", "trace", "accountability"],
    route: "/audit-log",
    body: [
      "Platform > Audit Log records every privileged write: who did it, when, from where, the route, and a redacted snapshot of what was sent.",
      "",
      "Filter by actor, action or date to answer 'who moved this shift' or 'who approved that entry'. Time-entry corrections are also shown as change history on the entry itself.",
      "",
      "Actions this assistant carries out on your behalf appear here attributed to you, and are marked as assistant-initiated so the two are distinguishable.",
    ].join("\n"),
  },
  {
    id: "dispatch-board",
    title: "Using the dispatch board",
    keywords: ["dispatch", "live map", "on duty", "coverage", "open shift", "no show", "vacancy"],
    feature: "liveMap",
    route: "/dispatch",
    body: [
      "Dispatch > Live Map shows who is currently clocked in and where, alongside the open posts for the day.",
      "",
      "From an open post you can assign an officer directly, or notify every eligible officer that the shift is vacant and let them claim it.",
      "",
      "A shift's status is not advanced automatically as time passes, so a shift that has finished can still read as upcoming. Judge coverage by the shift's end time, not by its status label.",
      "",
      "Officers can only clock in from 30 minutes before the shift starts until it ends. If GPS cannot place them at the site — which happens on wifi-based location — they fall back to picking the site by hand, and that path requires an accepted roster place at that site.",
    ].join("\n"),
  },
  {
    id: "swap-requests",
    title: "Shift swaps between officers",
    keywords: ["swap", "trade shift", "swap request", "hand over", "give away a shift"],
    feature: "swapRequests",
    route: "/swap-requests",
    body: [
      "An officer offers their shift to another eligible officer; you approve the trade from Staffing > Swap Requests.",
      "",
      "Without this, every trade is a phone call to whoever is running the roster.",
    ].join("\n"),
  },
  {
    id: "coverage-requests",
    title: "Coverage requests from clients",
    keywords: ["coverage request", "extra cover", "callout", "client asks for cover"],
    route: "/hr/coverage-requests",
    body: [
      "A client or site contact asks for extra coverage from their own portal, and approving the request creates the shift — Staffing > Coverage Requests, with the site, times and headcount already filled in.",
      "",
      "Without it, the request arrives as an email somebody has to retype into the roster.",
    ].join("\n"),
  },
  {
    // Availability is its own plan feature, separate from coverage requests.
    id: "officer-availability",
    title: "Officer availability",
    keywords: ["availability", "available", "unavailable", "time off", "who is free", "work windows"],
    feature: "availability",
    route: "/personnel",
    body: [
      "Officers record the windows they can work from the mobile app, and you can see who has any on file from Dispatch > Personnel.",
      "",
      "With availability recorded, filling an open post stops being guesswork about who is free — you can see it before you start calling around.",
    ].join("\n"),
  },
];

/**
 * How to name a switched-off capability to a portal admin — the assistant has
 * to say "X is not enabled", and "swapRequests" is not something a person says.
 * Keyed by every feature so a key never leaks into a reply; anything new falls
 * back to the raw key rather than going missing.
 */
const FEATURE_LABELS: Partial<Record<FeatureKey, string>> = {
  payroll: "Payroll (Payroll Board, Pay Run, paystubs)",
  invoicing: "Client invoicing",
  incidents: "Incident reporting",
  dar: "Daily activity reports",
  patrol: "Patrol checkpoints",
  swapRequests: "Shift swap requests",
  availability: "Officer availability",
  hr: "The hiring pipeline (applications, onboarding, invitations)",
  liveMap: "The live map and dispatch board",
  chat: "Team chat",
  radio: "Push-to-talk radio",
  policies: "Policies",
  licenseRenewals: "Licence renewals",
  trainings: "Training certifications",
  exports: "Bulk data exports",
  officerShares: "Officer profile share links",
  assistant: "This assistant",
};

export function featureLabel(key: FeatureKey): string {
  return FEATURE_LABELS[key] ?? key;
}

/**
 * Portal pages that deliberately have no how-to article, and why.
 *
 * The assistant declines rather than improvising for these, which is the
 * intended behaviour — but "no article" has to be a decision someone made, not
 * an oversight. Every navigable portal route must appear either in an article's
 * `route`/`alsoCovers` or here; the admin-portal coverage test fails otherwise,
 * so a newly shipped page cannot slip past unnoticed.
 *
 * Delete the entry (and write the article) when a page grows a workflow worth
 * explaining.
 */
export const KB_ROUTES_WITHOUT_ARTICLE: Readonly<Record<string, string>> = {
  "/": "Landing dashboard — read-only summary tiles that link onward; nothing to walk anybody through.",
  "/assistant": "The assistant's own page. It explains itself in conversation.",
  "/chat": "Ordinary messaging UI; no portal-specific procedure to get wrong.",
  "/radio": "Push-to-talk radio. The failure modes are device/permission issues, not portal steps.",
  "/personnel/share-links": "Same share-link mechanics as incident shares, on an officer profile.",
  "/staffing": "Shiftboard-backed events surface; the authoritative instructions live in that external tool.",
  "/hr/reports": "Employee record-completeness report; a list to read.",
  "/tables/employees": "Standard admin record grid.",
  "/tables/training-certifications": "Standard admin record grid.",
  "/tables/sales_leads": "Standard admin record grid.",
  "/tables/subcontractors": "Standard admin record grid.",
  "/tables/subcontractor_cois": "Standard admin record grid.",
  "/tables/subcontractor_contracts": "Standard admin record grid.",
  "/tables/subcontractor_invoices": "Standard admin record grid.",
  "/subcontractors/clock-in-entries": "Read-only log of QR clock-ins by subcontractor staff.",
  "/subcontractors/invites": "Invite a vendor by email to their own self-service portal; simple invite/re-invite list, no multi-step procedure.",
  "/analytics": "Charts and totals; interpretation, not procedure.",
  "/tables/payment_discrepancies": "Standard admin record grid.",
  "/account/security": "Own password and sessions; standard account screen.",
  "/tables/users": "Standard admin record grid. Getting someone INTO the app is covered by the invite article.",
  "/recovery/shifts": "Rarely used repair tool; steps belong with the operator who is walked through it.",
  "/exports": "Data export downloads — pick a dataset and download.",
  "/settings/scheduler-integration": "External scheduler wiring, configured once during setup by whoever holds the credentials.",
  "/legal/agreements": "Platform agreement signing; the copy on the page is the authority and must not be paraphrased.",
  "/platform/features": "Platform-owner-only feature flags and pricing tiers; not a tenant admin surface.",
};

/**
 * Which article documents each portal route. First article wins when two cover
 * the same page (`/shifts` is both "creating" and "assigning"), which is fine —
 * the coverage test only asks whether a page is documented at all.
 */
export function knowledgeBaseRouteCoverage(): Map<string, string> {
  const byRoute = new Map<string, string>();
  for (const article of KB_ARTICLES) {
    for (const route of [article.route, ...(article.alsoCovers ?? [])]) {
      if (route && !byRoute.has(route)) byRoute.set(route, article.id);
    }
  }
  return byRoute;
}

/**
 * Does `word` name a subject in this article's title/keyword vocabulary?
 * Whole words only, with a plural allowance so "invoices" still points at the
 * invoicing article.
 */
/**
 * Question words that name no subject. Scoring is substring-based, so without
 * this a title containing "the" outscores a word the person actually cares
 * about.
 */
const STOPWORDS = new Set([
  "the", "and", "but", "for", "from", "into", "with", "about", "this", "that", "these", "those",
  "there", "here", "they", "them", "their", "your", "our", "its", "you", "how", "what", "when",
  "where", "which", "who", "why", "are", "was", "were", "can", "did", "does", "has", "have", "had",
  "will", "would", "should", "could", "need", "want", "just", "only", "also", "any", "all", "use",
  "using", "get", "got", "not",
]);

function namesSubject(vocabulary: Set<string>, word: string): boolean {
  return (
    vocabulary.has(word) ||
    vocabulary.has(`${word}s`) ||
    (word.endsWith("s") && vocabulary.has(word.slice(0, -1)))
  );
}

export type ArticleRetrieval = {
  /** Articles this company may actually be walked through. */
  articles: KbArticle[];
  /**
   * Features the question was about that this company has not switched on.
   * The matching article was withheld; the assistant says so rather than
   * describing a page that is not in this person's portal.
   */
  unavailable: Array<{ feature: FeatureKey; label: string }>;
};

/**
 * Score-and-select the articles most likely to answer `question`, skipping
 * anything whose feature this company has switched off.
 *
 * Retrieval happens in code, not by asking the model to pick a document: it is
 * cheaper, it cannot hallucinate an article id, and it keeps the grounding set
 * bounded no matter what the user types.
 *
 * `isEnabled` is injected rather than imported so this module stays free of
 * server dependencies (the admin-portal coverage test imports it directly).
 * Default is "everything on", which is also how the portal treats an unknown
 * flag.
 */
export function retrieveArticles(
  question: string,
  opts: { limit?: number; isEnabled?: (feature: FeatureKey) => boolean } = {},
): ArticleRetrieval {
  const limit = opts.limit ?? 3;
  const isEnabled = opts.isEnabled ?? (() => true);

  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (words.length === 0) return { articles: [], unavailable: [] };

  const scored = KB_ARTICLES.map((a) => {
    const title = a.title.toLowerCase();
    const keywords = a.keywords.join(" ").toLowerCase();
    const body = a.body.toLowerCase();
    let score = 0;
    for (const w of new Set(words)) {
      if (title.includes(w)) score += 5;
      if (keywords.includes(w)) score += 4;
      if (body.includes(w)) score += 1;
    }
    // Which query words name this article's subject, as whole words. Scoring
    // stays substring-based, but "create" must not count as naming an article
    // titled "...account created", or one stray verb decides that a whole
    // feature is what the person was asking about.
    //
    // A multi-word keyword names a compound subject and only counts whole:
    // "vendor invoice" on the subcontractor article is not that article laying
    // claim to the word "invoice", which is what a client-invoicing question
    // is made of.
    const vocabulary = new Set([
      ...title.split(/[^a-z0-9]+/).filter(Boolean),
      ...a.keywords.map((k) => k.toLowerCase().trim()),
    ]);
    const named = [...new Set(words)].filter((w) => namesSubject(vocabulary, w));
    return { a, score, named, enabled: !a.feature || isEnabled(a.feature) };
  })
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score);

  // Vocabulary the company's OWN articles answer to. "shift" and "officer" are
  // everywhere; a disabled article matching only on those has not been asked
  // about, and saying "swap requests are switched off" to someone asking how to
  // create a shift is noise on an answer they could otherwise have used.
  const enabledVocabulary = new Set(scored.filter((s) => s.enabled).flatMap((s) => s.named));
  const bestEnabledScore = Math.max(0, ...scored.filter((s) => s.enabled).map((s) => s.score));

  const articles: KbArticle[] = [];
  const unavailable = new Map<FeatureKey, string>();
  for (const s of scored) {
    if (!s.enabled) {
      // Worth telling them the feature is off when the question either used a
      // word only this subject answers to, or outmatched everything they do
      // have by a clear margin. Otherwise it was an aside, and their real
      // question still gets a straight answer.
      const asked =
        s.named.some((w) => !enabledVocabulary.has(w)) || s.score > bestEnabledScore * 1.5;
      if (asked) unavailable.set(s.a.feature!, featureLabel(s.a.feature!));
      continue;
    }
    if (articles.length < limit) articles.push(s.a);
  }

  return {
    articles,
    unavailable: [...unavailable].map(([feature, label]) => ({ feature, label })),
  };
}

/**
 * Short "what I can answer about" list for the system prompt. Topics whose
 * feature is switched off are left out — advertising them only invites a
 * question the assistant then has to refuse.
 */
export function knowledgeBaseIndex(isEnabled: (feature: FeatureKey) => boolean = () => true): string {
  return KB_ARTICLES.filter((a) => !a.feature || isEnabled(a.feature))
    .map((a) => `- ${a.title}`)
    .join("\n");
}
