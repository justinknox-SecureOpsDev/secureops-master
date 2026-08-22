import { randomUUID } from "node:crypto";
import { Type, type FunctionDeclaration } from "@google/genai";
import { eq } from "drizzle-orm";
import { db, timeEntriesTable } from "@workspace/db";
import { dispatchAsUser } from "./internalDispatch";
import { computeFindings, findingsForModel } from "./signals";

/**
 * The assistant's tool surface.
 *
 * Two kinds of tool live here and the difference matters:
 *
 *   Lookups  — narrow, read-only name→id resolution scoped to what the
 *              signed-in user may already see. They exist so the model can
 *              turn "Riverside" into a site id, and nothing more. They are not
 *              a general query interface over the database.
 *
 *   Actions  — exactly three, each performed by calling the SAME HTTP route
 *              the portal UI calls, as the signed-in user. No direct writes,
 *              no reimplemented handler logic. See internalDispatch.ts.
 *
 * Every argument is validated in code before dispatch. Model output is never
 * interpolated into SQL, a shell, HTML, or a redirect.
 */

// ── Argument validation ────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ArgError = { error: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function uuid(v: unknown, label: string): string | ArgError {
  const s = str(v);
  if (!s) return { error: `${label} is required.` };
  if (!UUID_RE.test(s)) return { error: `${label} must be an id returned by a lookup, not a name.` };
  return s;
}

function isoInstant(v: unknown, label: string): string | ArgError {
  const s = str(v);
  if (!s) return { error: `${label} is required.` };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { error: `${label} was not a recognisable date and time.` };
  return d.toISOString();
}

function isArgError(v: unknown): v is ArgError {
  return typeof v === "object" && v !== null && "error" in v;
}

/**
 * Escape LIKE wildcards in a user/model-supplied search term. Drizzle already
 * parameterises the value, so this is not about injection — it stops "%" from
 * turning a name lookup into "match everything".
 */
function likeTerm(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ── Tool declarations handed to the model ──────────────────────────────────

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "list_adoption_findings",
    description:
      "List capabilities this account is paying for but not using, computed from their own data. Use for questions like 'what am I not using', 'how could we be more efficient', 'what are we missing'. Returns pre-measured findings — report them as given and never add findings or numbers of your own.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "find_site",
    description:
      "Look up a site by name to get its id. Use before any tool that needs a siteId. Returns every match — if more than one comes back, ask the person which they mean.",
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING, description: "Part of the site name, e.g. 'Riverside'." } },
      required: ["query"],
    },
  },
  {
    name: "find_employee",
    description:
      "Look up a member of staff by name or email to get their id. Use before any tool that needs an employeeId. Returns every match — if more than one comes back, ask the person which they mean.",
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING, description: "Part of a name or email, e.g. 'James'." } },
      required: ["query"],
    },
  },
  {
    name: "find_shift",
    description:
      "Find shifts so you can get a shiftId. Filter by site and/or a date range. Only returns shifts the signed-in user is allowed to see.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        siteId: { type: Type.STRING, description: "Optional site id from find_site." },
        fromDate: { type: Type.STRING, description: "Optional ISO date/time lower bound." },
        toDate: { type: Type.STRING, description: "Optional ISO date/time upper bound." },
      },
    },
  },
  {
    name: "find_time_entry",
    description:
      "Find a clocked-out time entry awaiting approval, so you can get a timeEntryId. Filter by employee and/or date range.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        employeeId: { type: Type.STRING, description: "Optional employee id from find_employee." },
        fromDate: { type: Type.STRING, description: "Optional ISO date/time lower bound on the clock-in." },
        toDate: { type: Type.STRING, description: "Optional ISO date/time upper bound on the clock-in." },
      },
    },
  },
  {
    name: "create_shift",
    description:
      "Create a new shift. Requires a confirmed site id, title, start and end time. Never guess a rate — leave payRate/billRate out unless the person stated them, and the site's defaults will be used.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        siteId: { type: Type.STRING, description: "Site id from find_site." },
        title: { type: Type.STRING, description: "Short title for the post, e.g. 'Night patrol'." },
        startTime: { type: Type.STRING, description: "ISO 8601 start instant." },
        endTime: { type: Type.STRING, description: "ISO 8601 end instant." },
        requiredLicenseLevel: { type: Type.INTEGER, description: "Texas licence level 1-4. Defaults to 2 (unarmed)." },
        headcount: { type: Type.INTEGER, description: "How many officers are needed. Defaults to 1." },
        payRate: { type: Type.NUMBER, description: "Only if the person explicitly stated an hourly pay rate." },
        billRate: { type: Type.NUMBER, description: "Only if the person explicitly stated an hourly bill rate." },
        notes: { type: Type.STRING, description: "Optional instructions for the officer." },
      },
      required: ["siteId", "title", "startTime", "endTime"],
    },
  },
  {
    name: "assign_officer_to_shift",
    description: "Put an officer on an existing shift's roster.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        shiftId: { type: Type.STRING, description: "Shift id from find_shift." },
        employeeId: { type: Type.STRING, description: "Employee id from find_employee." },
      },
      required: ["shiftId", "employeeId"],
    },
  },
  {
    name: "approve_time_entry",
    description:
      "Approve or reject a clocked-out time entry. Approving releases the hours to payroll and to the client invoice, so this always needs the person's explicit confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        timeEntryId: { type: Type.STRING, description: "Time entry id from find_time_entry." },
        decision: { type: Type.STRING, description: "Either 'approved' or 'rejected'." },
      },
      required: ["timeEntryId", "decision"],
    },
  },
];

export const ACTION_TOOLS = new Set(["create_shift", "assign_officer_to_shift", "approve_time_entry"]);

/**
 * Explicit allowlist of what may run WITHOUT a human clicking Approve.
 *
 * Written as an allowlist on purpose: a tool added later is approval-required
 * by default rather than silently autonomous. `autonomous` may return false for
 * a specific set of arguments even on an allowlisted tool — creating a shift is
 * fine until it carries money.
 */
const AUTONOMOUS: Record<string, (args: Record<string, unknown>) => boolean> = {
  // Deliberately empty. Every action the assistant can currently take creates
  // financial exposure, so every one of them waits for a click:
  //
  //   create_shift             — the shift persists pay and bill rates. Leaving
  //                              them out does not make it free; it inherits
  //                              the site defaults, and the hours it generates
  //                              land in payroll and on a client invoice.
  //   assign_officer_to_shift  — putting a named person on an already-priced
  //                              post is the moment the company commits to
  //                              paying for it.
  //   approve_time_entry       — releases hours straight into payroll and
  //                              invoicing.
  //
  // Kept as an allowlist rather than deleted: a purely informational or
  // trivially reversible tool added later can be listed here explicitly, and
  // anything not listed stays approval-required by default.
};

export function requiresApproval(tool: string, args: Record<string, unknown>): boolean {
  const rule = AUTONOMOUS[tool];
  if (!rule) return true;
  return !rule(args);
}

// ── Lookup implementations ─────────────────────────────────────────────────

export type ToolContext = {
  user: { userId: string; role: string; email: string };
  authorization: string;
  originRef: string;
  /**
   * Stable key for the ONE write this context may perform, supplied by
   * whoever authorised it (the approve route derives it from the pending
   * action's id). It makes an interrupted dispatch safe to re-send: the route
   * replays its recorded outcome rather than performing the work twice.
   * Absent, `executeAction` mints a fresh key per call.
   */
  idempotencyKey?: string;
};

type LookupResult = Record<string, unknown>;

/**
 * Read a list through the caller's OWN HTTP route instead of the database.
 *
 * Every lookup the assistant performs goes through here. Querying tables
 * directly would mean re-implementing each route's scoping rules in a second
 * place, where they can drift: the assistant is reachable by any staff member,
 * but the roster, the site list and the time-entry list each apply their own
 * narrower policy and their own field-stripping. Re-entering the route keeps
 * one copy of that policy and inherits any future tightening of it for free.
 */
async function listAsCaller(
  ctx: ToolContext,
  path: string,
  key?: string,
): Promise<{ rows: Array<Record<string, unknown>> } | ArgError> {
  const res = await dispatchAsUser({ method: "GET", path, authorization: ctx.authorization });
  if (!res.ok) {
    return {
      error:
        res.status === 403
          ? "That is not something your role is able to look up."
          : "That lookup could not be completed.",
    };
  }
  const body = res.body as unknown;
  const raw: unknown[] = Array.isArray(body)
    ? body
    : key && Array.isArray((body as Record<string, unknown> | null)?.[key])
      ? ((body as Record<string, unknown>)[key] as unknown[])
      : [];
  return { rows: raw.map((r) => r as Record<string, unknown>) };
}

const text = (row: Record<string, unknown>, key: string): string =>
  typeof row[key] === "string" ? (row[key] as string) : "";

async function findSite(ctx: ToolContext, args: Record<string, unknown>): Promise<LookupResult> {
  const q = str(args["query"]);
  if (!q) return { error: "A site name is required." };

  const list = await listAsCaller(ctx, "/api/sites", "sites");
  if (isArgError(list)) return list;

  const needle = q.toLowerCase();
  const matches = list.rows
    .filter((r) => typeof r["id"] === "string" && text(r, "name").toLowerCase().includes(needle))
    .slice(0, 8)
    .map((r) => ({ id: r["id"], name: r["name"], status: r["status"], address: r["address"] }));
  return { matches, count: matches.length };
}

async function findEmployee(ctx: ToolContext, args: Record<string, unknown>): Promise<LookupResult> {
  const q = str(args["query"]);
  if (!q) return { error: "A name or email is required." };

  // The staff directory is read through the caller's OWN HTTP surface, never
  // with a privileged query. Otherwise this tool becomes a staff-enumeration
  // endpoint for anyone who can open the assistant: requireStaff admits
  // ordinary employees, but the portal itself only shows the roster to
  // scheduling staff. Going through the route means the assistant sees exactly
  // the directory the person could already browse — including the PII-stripped
  // projection dispatchers and site managers get — and inherits any future
  // tightening of that policy for free.
  const res = await dispatchAsUser({
    method: "GET",
    path: `/api/employees?search=${encodeURIComponent(q)}`,
    authorization: ctx.authorization,
  });
  if (!res.ok) {
    return {
      error:
        res.status === 403
          ? "Looking up other members of staff is not something your role can do."
          : "That staff lookup could not be completed.",
    };
  }

  const payload = res.body as { employees?: unknown } | unknown[] | null;
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { employees?: unknown })?.employees)
      ? ((payload as { employees: unknown[] }).employees)
      : [];

  // Narrow the route's rich row down to what rostering actually needs. Only
  // fields that came back in the caller's own response are ever surfaced.
  const matches = list
    .map((row) => row as Record<string, unknown>)
    .filter((row) => typeof row["id"] === "string")
    // Client-portal accounts are external contacts and can never be rostered,
    // so they are not resolvable as "an employee" at all.
    .filter((row) => row["role"] !== "client")
    .slice(0, 8)
    .map((row) => ({
      id: row["id"] as string,
      name: [row["firstName"], row["lastName"]].filter(Boolean).join(" ").trim() || String(row["email"] ?? ""),
      role: row["role"],
      status: row["status"],
    }));

  return { matches, count: matches.length };
}

async function findShift(ctx: ToolContext, args: Record<string, unknown>): Promise<LookupResult> {
  const siteId = args["siteId"] === undefined ? null : uuid(args["siteId"], "siteId");
  if (isArgError(siteId)) return siteId;

  const from = args["fromDate"] === undefined ? null : isoInstant(args["fromDate"], "fromDate");
  if (isArgError(from)) return from;
  const to = args["toDate"] === undefined ? null : isoInstant(args["toDate"], "toDate");
  if (isArgError(to)) return to;

  // Default to a sane window rather than dumping the whole roster.
  const params = new URLSearchParams();
  params.set("from", from ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  if (to) params.set("to", to);

  // The route decides what this caller may see: admins and dispatchers get
  // every site, a site manager only the sites they manage plus their own work,
  // an officer only their own and qualifying-open shifts. It also strips the
  // bill rate from anyone who may not see it.
  const list = await listAsCaller(ctx, `/api/shifts?${params.toString()}`);
  if (isArgError(list)) return list;

  const matches = list.rows
    .filter((r) => typeof r["id"] === "string" && (siteId ? r["siteId"] === siteId : true))
    .sort((a, b) => text(a, "startTime").localeCompare(text(b, "startTime")))
    .slice(0, 15)
    .map((r) => ({
      id: r["id"],
      title: r["title"],
      siteId: r["siteId"],
      location: r["location"],
      startTime: r["startTime"],
      endTime: r["endTime"],
      headcount: r["headcount"],
      requiredLicenseLevel: r["requiredLicenseLevel"],
    }));
  return { matches, count: matches.length };
}

async function findTimeEntry(ctx: ToolContext, args: Record<string, unknown>): Promise<LookupResult> {
  const employeeId = args["employeeId"] === undefined ? null : uuid(args["employeeId"], "employeeId");
  if (isArgError(employeeId)) return employeeId;
  const from = args["fromDate"] === undefined ? null : isoInstant(args["fromDate"], "fromDate");
  if (isArgError(from)) return from;
  const to = args["toDate"] === undefined ? null : isoInstant(args["toDate"], "toDate");
  if (isArgError(to)) return to;

  const params = new URLSearchParams();
  if (employeeId) params.set("employeeId", employeeId);
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  // The route applies the caller's visibility: admins see everyone, a site
  // manager only the sites they manage, anyone else only their own entries.
  const qs = params.toString();
  const list = await listAsCaller(ctx, `/api/time-entries${qs ? `?${qs}` : ""}`);
  if (isArgError(list)) return list;

  // Only closed entries can be approved, so an open one is not a useful match.
  const matches = list.rows
    .filter((r) => typeof r["id"] === "string" && r["clockOutTime"])
    .slice(0, 15)
    .map((r) => ({
      id: r["id"],
      employeeId: r["employeeId"],
      employeeName: r["employeeName"],
      clockInTime: r["clockInTime"],
      clockOutTime: r["clockOutTime"],
      hoursWorked: r["hoursWorked"],
      approvalStatus: r["approvalStatus"],
    }));
  return { matches, count: matches.length };
}

// ── Action implementations ─────────────────────────────────────────────────

export type StagedAction = {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  details: Array<{ label: string; value: string }>;
};

/**
 * Validate an action's arguments and build the human-readable summary shown
 * on the approval card. Returns an ArgError when the model produced something
 * we will not dispatch.
 */
export async function prepareAction(
  ctx: ToolContext,
  tool: string,
  raw: Record<string, unknown>,
): Promise<StagedAction | ArgError> {
  if (tool === "create_shift") {
    const siteId = uuid(raw["siteId"], "siteId");
    if (isArgError(siteId)) return siteId;
    const title = str(raw["title"]);
    if (!title) return { error: "A shift title is required." };
    const startTime = isoInstant(raw["startTime"], "startTime");
    if (isArgError(startTime)) return startTime;
    const endTime = isoInstant(raw["endTime"], "endTime");
    if (isArgError(endTime)) return endTime;
    if (new Date(endTime) <= new Date(startTime)) {
      return { error: "The shift's end time must be after its start time." };
    }
    const level = Number(raw["requiredLicenseLevel"]);
    const requiredLicenseLevel = [1, 2, 3, 4].includes(level) ? level : 2;
    const headcountRaw = Number(raw["headcount"]);
    const headcount = Number.isFinite(headcountRaw) && headcountRaw >= 1 ? Math.floor(headcountRaw) : 1;
    const payRate = raw["payRate"] == null ? undefined : Number(raw["payRate"]);
    const billRate = raw["billRate"] == null ? undefined : Number(raw["billRate"]);
    if (payRate !== undefined && (!Number.isFinite(payRate) || payRate < 0)) {
      return { error: "payRate must be a non-negative number." };
    }
    if (billRate !== undefined && (!Number.isFinite(billRate) || billRate < 0)) {
      return { error: "billRate must be a non-negative number." };
    }
    const notes = str(raw["notes"]) ?? undefined;

    // Read the site's name through the caller's OWN HTTP surface, never with a
    // privileged query. If they may not read it, the card simply says less —
    // the POST route below stays the authority on whether they may create the
    // shift, so a refused read must not block a legitimate action.
    const siteRes = await dispatchAsUser({
      method: "GET",
      path: `/api/sites/${encodeURIComponent(siteId)}`,
      authorization: ctx.authorization,
    });
    const site = siteRes.ok ? ((siteRes.body ?? null) as { name?: string } | null) : null;

    const args: Record<string, unknown> = {
      siteId, title, startTime, endTime, requiredLicenseLevel, headcount,
      ...(payRate === undefined ? {} : { payRate }),
      ...(billRate === undefined ? {} : { billRate }),
      ...(notes === undefined ? {} : { notes }),
    };
    const details: Array<{ label: string; value: string }> = [
      { label: "Site", value: site?.name ?? siteId },
      { label: "Title", value: title },
      { label: "Starts", value: startTime },
      { label: "Ends", value: endTime },
      { label: "Officers needed", value: String(headcount) },
      { label: "Licence level", value: String(requiredLicenseLevel) },
    ];
    if (payRate !== undefined) details.push({ label: "Pay rate", value: `${payRate.toFixed(2)} / hour` });
    if (billRate !== undefined) details.push({ label: "Bill rate", value: `${billRate.toFixed(2)} / hour` });
    if (notes) details.push({ label: "Notes", value: notes });

    return {
      tool,
      args,
      summary: `Create a new shift "${title}" at ${site?.name ?? "the selected site"}.`,
      details,
    };
  }

  if (tool === "assign_officer_to_shift") {
    const shiftId = uuid(raw["shiftId"], "shiftId");
    if (isArgError(shiftId)) return shiftId;
    const employeeId = uuid(raw["employeeId"], "employeeId");
    if (isArgError(employeeId)) return employeeId;

    // Same rule as above, but here the read is load-bearing: refuse outright
    // rather than describe a shift the caller cannot see. A site manager who
    // guesses a foreign shift id gets nothing back, not a filled-in card.
    const shiftRes = await dispatchAsUser({
      method: "GET",
      path: `/api/shifts/${encodeURIComponent(shiftId)}`,
      authorization: ctx.authorization,
    });
    if (!shiftRes.ok) {
      return {
        error:
          shiftRes.status === 404
            ? "That shift no longer exists."
            : "That shift is not one you are able to work with.",
      };
    }
    const shift = (shiftRes.body ?? null) as { title?: string; startTime?: string; location?: string } | null;

    // The officer's name is read through the caller's OWN employee route, not
    // the users table. The model's arguments are untrusted, so a direct query
    // here would let anyone who can open the assistant turn a guessed uuid into
    // a card naming a colleague — the route refuses ordinary officers, and the
    // eventual 403 on the assignment itself would come too late to take the
    // name back.
    //
    // One message covers refused, missing and not-staff alike: separate
    // wording would make this an existence oracle for uuids.
    const NOT_ROSTERABLE = "That id does not belong to a member of staff you can roster.";
    const personRes = await dispatchAsUser({
      method: "GET",
      path: `/api/employees/${encodeURIComponent(employeeId)}`,
      authorization: ctx.authorization,
    });
    if (!personRes.ok) return { error: NOT_ROSTERABLE };
    const personRow = (personRes.body ?? null) as Record<string, unknown> | null;
    // Client-portal contacts are external and can never be rostered.
    const ROSTERABLE = ["admin", "dispatcher", "employee", "site_manager"];
    if (!personRow || !ROSTERABLE.includes(String(personRow["role"]))) {
      return { error: NOT_ROSTERABLE };
    }
    const personName =
      [personRow["firstName"], personRow["lastName"]].filter(Boolean).join(" ").trim() ||
      "that member of staff";

    return {
      tool,
      args: { shiftId, employeeId },
      summary: `Put ${personName} on "${shift?.title ?? "the selected shift"}".`,
      details: [
        { label: "Officer", value: personName },
        { label: "Shift", value: shift?.title ?? shiftId },
        { label: "Starts", value: shift?.startTime ?? "unknown" },
        { label: "Where", value: shift?.location ?? "unknown" },
      ],
    };
  }

  if (tool === "approve_time_entry") {
    const timeEntryId = uuid(raw["timeEntryId"], "timeEntryId");
    if (isArgError(timeEntryId)) return timeEntryId;
    const decision = str(raw["decision"]);
    if (decision !== "approved" && decision !== "rejected") {
      return { error: "decision must be either 'approved' or 'rejected'." };
    }

    // There is no by-id read route for a time entry, so this takes two steps.
    // Step one is a deliberately minimal internal probe — an employee id and a
    // timestamp, used ONLY to build a narrow query. Nothing from it is shown to
    // anyone: if step two comes back empty, the caller learns only that they
    // cannot act on that id.
    //
    // "Missing" and "not yours" must be indistinguishable. Two different
    // messages would turn guessed uuids into an existence oracle — a site
    // manager could learn that a foreign officer's entry exists, which is
    // itself information they are not entitled to.
    const NOT_ACTIONABLE = "There is no time entry with that id that you can act on.";

    const [probe] = await db
      .select({ employeeId: timeEntriesTable.employeeId, clockInTime: timeEntriesTable.clockInTime })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, timeEntryId))
      .limit(1);
    if (!probe) return { error: NOT_ACTIONABLE };

    // Step two reads it back through the caller's own list route, which
    // applies their visibility rules (admins see all, site managers only their
    // sites, everyone else only themselves) and strips finance they may not
    // see. Every value on the card comes from THIS response.
    const at = probe.clockInTime.getTime();
    const listRes = await dispatchAsUser({
      method: "GET",
      path:
        `/api/time-entries?employeeId=${encodeURIComponent(probe.employeeId)}` +
        `&from=${encodeURIComponent(new Date(at - 1000).toISOString())}` +
        `&to=${encodeURIComponent(new Date(at + 1000).toISOString())}`,
      authorization: ctx.authorization,
    });
    const entry = (Array.isArray(listRes.body) ? (listRes.body as Array<Record<string, unknown>>) : []).find(
      (r) => r["id"] === timeEntryId,
    );
    if (!listRes.ok || !entry) {
      return { error: NOT_ACTIONABLE };
    }

    const name = typeof entry["employeeName"] === "string" ? entry["employeeName"] : "this officer";
    const textOr = (key: string, fallback: string): string => {
      const v = entry[key];
      return typeof v === "string" && v !== "" ? v : fallback;
    };

    return {
      tool,
      args: { timeEntryId, decision },
      summary:
        decision === "approved"
          ? `Approve ${name}'s time entry — this releases the hours to payroll and to the client invoice.`
          : `Reject ${name}'s time entry.`,
      details: [
        { label: "Officer", value: name },
        { label: "Clocked in", value: textOr("clockInTime", "unknown") },
        { label: "Clocked out", value: textOr("clockOutTime", "still open") },
        { label: "Hours", value: textOr("hoursWorked", "unknown") },
        { label: "Decision", value: decision },
      ],
    };
  }

  return { error: `Unknown action '${tool}'.` };
}

export type ActionOutcome = {
  ok: boolean;
  status: number;
  message: string;
  /** True when the outcome is genuinely unknown — see internalDispatch. */
  unconfirmed?: boolean;
  /**
   * The first dispatch was interrupted and this outcome came from re-sending
   * it under the same idempotency key. Definite, not a guess — and worth
   * saying out loud, because the person may have been told nothing at all.
   */
  reconciled?: boolean;
  /** Safe, non-sensitive echo of what was created/changed. */
  result?: Record<string, unknown>;
};

/**
 * What to tell someone whose action was interrupted.
 *
 * `replayed` distinguishes the two honest stories: the server recognised the
 * key and handed back the outcome the lost attempt had already committed, or
 * the lost attempt never committed and this send did the work. Both mean it
 * happened exactly once — but only one of them means "it was already done".
 */
function reconciledMessage(replayed: boolean): string {
  return replayed
    ? "Done. The first attempt was interrupted, but it had already gone through — I checked rather than repeating it, so it was applied once."
    : "Done. The first attempt was interrupted before it took effect, so I safely sent it again. It has been applied once.";
}

/**
 * Execute a prepared action by calling the portal's own endpoint as the user.
 * Nothing here writes to the database; the route does, exactly as it does for
 * a click in the UI.
 */
export async function executeAction(ctx: ToolContext, action: StagedAction): Promise<ActionOutcome> {
  const routes: Record<string, { method: "POST"; path: string; body: Record<string, unknown> }> = {
    create_shift: { method: "POST", path: "/api/shifts", body: action.args },
    assign_officer_to_shift: {
      method: "POST",
      path: `/api/shifts/${encodeURIComponent(String(action.args["shiftId"]))}/assignments`,
      body: { employeeId: action.args["employeeId"] },
    },
    approve_time_entry: {
      method: "POST",
      path: `/api/time-entries/${encodeURIComponent(String(action.args["timeEntryId"]))}/approve`,
      body: { decision: action.args["decision"] },
    },
  };

  const spec = routes[action.tool];
  if (!spec) return { ok: false, status: 400, message: `Unknown action '${action.tool}'.` };

  const res = await dispatchAsUser({
    method: spec.method,
    path: spec.path,
    authorization: ctx.authorization,
    body: spec.body,
    originRef: ctx.originRef,
    // Every action carries a key, so a dispatch whose answer is lost can be
    // re-sent for a definite outcome instead of leaving the person to go and
    // check a payroll approval by hand. A caller that owns the retry (the
    // approve route) supplies a stable one; otherwise one call, one key.
    idempotencyKey: ctx.idempotencyKey ?? `assistant-action:${randomUUID()}`,
  });

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      ...(res.unconfirmed ? { unconfirmed: true as const } : {}),
      ...(res.reconciled ? { reconciled: true as const } : {}),
      // Surface the API's own refusal verbatim — a dispatcher who cannot do
      // this by clicking gets exactly the same answer here.
      message: res.message ?? `The action was refused (${res.status}).`,
    };
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    status: res.status,
    ...(res.reconciled ? { reconciled: true as const } : {}),
    message: res.reconciled ? reconciledMessage(res.replayed === true) : "Done.",
    result: { id: body["id"] ?? null, title: body["title"] ?? null, status: body["status"] ?? null },
  };
}

// ── Dispatcher for non-action (read-only) tools ────────────────────────────

export async function runLookupTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "list_adoption_findings": {
      const findings = await computeFindings(ctx.user);
      return { findings, rendered: findingsForModel(findings), count: findings.length };
    }
    case "find_site":
      return findSite(ctx, args);
    case "find_employee":
      return findEmployee(ctx, args);
    case "find_shift":
      return findShift(ctx, args);
    case "find_time_entry":
      return findTimeEntry(ctx, args);
    default:
      return { error: `Unknown tool '${name}'.` };
  }
}
