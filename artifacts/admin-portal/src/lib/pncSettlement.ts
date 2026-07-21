// Settlement label derived from a raw PNC status response. PNC's exact schema
// varies by API version, so we scan the payload for status-like string fields
// and bucket them: rejected > settled > accepted > pending (most-specific wins).
export type PncSettlement = "pending" | "accepted" | "settled" | "rejected" | "error";

export const derivePncSettlement = (data: unknown): PncSettlement => {
  const statuses: string[] = [];
  const walk = (v: unknown): void => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string" && /status|state/i.test(k)) statuses.push(val.toLowerCase());
        else walk(val);
      }
    }
  };
  walk(data);
  if (statuses.some((s) => /reject|fail|return|error|cancel/.test(s))) return "rejected";
  if (statuses.some((s) => /settl|complet|paid|success/.test(s))) return "settled";
  if (statuses.some((s) => /accept|approv|process|submit/.test(s))) return "accepted";
  return "pending";
};

export const PNC_BADGE_STYLES: Record<PncSettlement, string> = {
  pending: "bg-gray-100 text-gray-700 border-gray-300",
  accepted: "bg-yellow-100 text-yellow-800 border-yellow-300",
  settled: "bg-green-100 text-green-800 border-green-300",
  rejected: "bg-red-100 text-red-800 border-red-300",
  error: "bg-gray-100 text-gray-500 border-gray-300",
};

export const PNC_BADGE_LABELS: Record<PncSettlement, string> = {
  pending: "PNC: Pending",
  accepted: "PNC: Accepted",
  settled: "PNC: Settled",
  rejected: "PNC: Rejected",
  error: "PNC: Unavailable",
};
