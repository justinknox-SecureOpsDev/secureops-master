import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Centralized guard against silent operational-data loss when a site (or a
// client, which CASCADE-deletes its sites) is hard-deleted.
//
// Why this exists: an admin clearing out what looked like a duplicate once
// hard-deleted a live site. Because the FK behaviors split — shifts / patrol
// scans / DARs / invoices / payroll are ON DELETE SET NULL, while subcontractor
// QR tokens + scan entries, patrol checkpoints and shift requests are ON DELETE
// CASCADE — the delete silently orphaned dozens of shifts and permanently
// cascade-deleted the site's QR code and its scan history. Every site/client
// delete path must run this first and refuse (409) while dependents exist.

export type DeletionBlockers = Record<string, number>;

const HTTP_CONFLICT = 409;

// Count the operational records a single site still owns. Returns only the
// non-zero buckets so callers can both decide (any keys?) and report (counts).
export async function siteBlockersForOne(siteId: string): Promise<DeletionBlockers> {
  const [counts] = (
    await db.execute(sql`
      SELECT
        (SELECT count(*) FROM shifts WHERE site_id = ${siteId}) AS shifts,
        (SELECT count(*) FROM subcontractor_qr_tokens WHERE site_id = ${siteId}) AS qr_tokens,
        (SELECT count(*) FROM subcontractor_time_entries WHERE site_id = ${siteId}) AS qr_entries,
        (SELECT count(*) FROM patrol_checkpoints WHERE site_id = ${siteId}) AS patrol_checkpoints,
        (SELECT count(*) FROM patrol_scans WHERE site_id = ${siteId}) AS patrol_scans,
        (SELECT count(*) FROM shift_requests WHERE site_id = ${siteId}) AS shift_requests,
        (SELECT count(*) FROM daily_activity_reports WHERE site_id = ${siteId}) AS dars,
        (SELECT count(*) FROM invoices WHERE site_id = ${siteId}) AS invoices,
        (SELECT count(*) FROM payroll_entries WHERE site_id = ${siteId}) AS payroll_entries
    `)
  ).rows as unknown as Array<Record<string, string>>;
  const blockers: DeletionBlockers = {};
  for (const [k, v] of Object.entries(counts ?? {})) {
    const n = Number(v);
    if (n > 0) blockers[k] = n;
  }
  return blockers;
}

// Aggregate blocker buckets across one or more sites (a client delete cascades
// all of its sites, so every one must be checked).
export async function aggregateSiteBlockers(siteIds: string[]): Promise<DeletionBlockers> {
  const totals: DeletionBlockers = {};
  for (const siteId of siteIds) {
    const one = await siteBlockersForOne(siteId);
    for (const [k, v] of Object.entries(one)) totals[k] = (totals[k] ?? 0) + v;
  }
  return totals;
}

// Blockers for deleting a client: the sites it owns (which would cascade) plus
// every operational record under those sites. `sites` is included as a bucket
// so the admin sees the cascade scope.
export async function clientDeletionBlockers(clientId: string): Promise<DeletionBlockers> {
  const [row] = (
    await db.execute(sql`SELECT array_agg(id::text) AS ids FROM sites WHERE client_id = ${clientId}`)
  ).rows as unknown as Array<{ ids: string[] | null }>;
  const siteIds = row?.ids ?? [];
  if (siteIds.length === 0) return {};
  const blockers = await aggregateSiteBlockers(siteIds);
  if (Object.keys(blockers).length === 0) return {};
  return { sites: siteIds.length, ...blockers };
}

const SITE_MESSAGE =
  "Deleting this site would remove or unlink its shifts, QR code, patrol, " +
  "invoice and payroll history. Reassign or remove these first, or keep the " +
  "site so its records stay intact.";

const CLIENT_MESSAGE =
  "Deleting this client would also delete its sites, which still have shifts, " +
  "QR codes, patrol, invoice or payroll history. Remove those first, or keep " +
  "the client so its records stay intact.";

// Express helper: if `blockers` is non-empty, write the 409 body and return
// true (caller must stop). Returns false when the delete may proceed.
export function refuseIfBlocked(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  blockers: DeletionBlockers,
  kind: "site" | "client",
): boolean {
  if (Object.keys(blockers).length === 0) return false;
  res.status(HTTP_CONFLICT).json({
    error:
      kind === "client"
        ? "Client has sites with related records and cannot be deleted"
        : "Site has related records and cannot be deleted",
    message: kind === "client" ? CLIENT_MESSAGE : SITE_MESSAGE,
    blockers,
  });
  return true;
}
