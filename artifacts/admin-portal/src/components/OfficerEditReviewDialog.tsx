import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

// Minimal shape shared by the Payroll Board bucket entries and the Site
// detail time-entry rows: current (officer-submitted) times plus the
// originally recorded times the server snapshotted when the officer edited.
export type OfficerEditEntry = {
  id: string;
  employeeName?: string | null;
  clockInTime: string | null;
  clockOutTime: string | null;
  originalClockInTime?: string | null;
  originalClockOutTime?: string | null;
  employeeEditReason?: string | null;
};

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// Signed minute delta between the recorded and submitted timestamps, rendered
// as e.g. "+15 min" / "−30 min". Null when either side is missing.
function minuteDelta(original: string | null | undefined, submitted: string | null | undefined): string | null {
  if (!original || !submitted) return null;
  const a = new Date(original).getTime();
  const b = new Date(submitted).getTime();
  if (isNaN(a) || isNaN(b)) return null;
  const mins = Math.round((b - a) / 60000);
  if (mins === 0) return "no change";
  return `${mins > 0 ? "+" : "−"}${Math.abs(mins)} min`;
}

function DeltaBadge({ delta }: { delta: string | null }) {
  if (!delta) return null;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
        delta === "no change" ? "bg-gray-100 text-gray-600" : "bg-violet-100 text-violet-800"
      }`}
    >
      {delta}
    </span>
  );
}

// Side-by-side review of an officer's pre-submission time edit: originally
// recorded times vs what they submitted, per-timestamp minute deltas, and
// their stated reason. When onApprove/onReject are provided the footer also
// offers the decision buttons so admins can decide straight from the review.
export function OfficerEditReviewDialog({
  entry,
  onClose,
  onApprove,
  onReject,
  busy = false,
}: {
  entry: OfficerEditEntry | null;
  onClose: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  busy?: boolean;
}) {
  const inDelta = entry ? minuteDelta(entry.originalClockInTime, entry.clockInTime) : null;
  const outDelta = entry ? minuteDelta(entry.originalClockOutTime, entry.clockOutTime) : null;
  const hasOriginal = !!(entry?.originalClockInTime || entry?.originalClockOutTime);

  return (
    <Dialog open={!!entry} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Officer time edit</DialogTitle>
          <DialogDescription>
            {entry?.employeeName?.trim()
              ? `${entry.employeeName.trim()} edited their times before submitting this entry.`
              : "The officer edited their times before submitting this entry."}
          </DialogDescription>
        </DialogHeader>

        {entry && (
          <div className="space-y-4 text-sm">
            {hasOriginal ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-md border p-3">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                    Recorded (original)
                  </div>
                  <dl className="space-y-1.5">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Clock in</dt>
                      <dd className="text-right tabular-nums">{fmtTs(entry.originalClockInTime)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Clock out</dt>
                      <dd className="text-right tabular-nums">{fmtTs(entry.originalClockOutTime)}</dd>
                    </div>
                  </dl>
                </div>
                <div className="rounded-md border border-violet-300 bg-violet-50/50 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-violet-800 mb-2">
                    Submitted by officer
                  </div>
                  <dl className="space-y-1.5">
                    <div className="flex justify-between gap-2 items-center">
                      <dt className="text-muted-foreground">Clock in</dt>
                      <dd className="text-right tabular-nums flex items-center gap-1.5 justify-end flex-wrap">
                        <span>{fmtTs(entry.clockInTime)}</span>
                        <DeltaBadge delta={inDelta} />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2 items-center">
                      <dt className="text-muted-foreground">Clock out</dt>
                      <dd className="text-right tabular-nums flex items-center gap-1.5 justify-end flex-wrap">
                        <span>{fmtTs(entry.clockOutTime)}</span>
                        <DeltaBadge delta={outDelta} />
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground">
                The originally recorded times weren't captured for this entry — only the
                officer's submitted times are available: {fmtTs(entry.clockInTime)} →{" "}
                {fmtTs(entry.clockOutTime)}.
              </p>
            )}

            <div className="rounded-md bg-muted/50 p-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Reason</div>
              <p className={entry.employeeEditReason ? "" : "text-muted-foreground italic"}>
                {entry.employeeEditReason || "No reason provided."}
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          {onReject && (
            <Button variant="destructive" onClick={onReject} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Reject"}
            </Button>
          )}
          {onApprove && (
            <Button onClick={onApprove} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Approve"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
