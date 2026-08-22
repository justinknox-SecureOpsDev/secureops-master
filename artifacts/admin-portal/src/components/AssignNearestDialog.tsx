import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, isStillProcessing, STILL_SAVING_MESSAGE } from "@/lib/api";
import { useIdempotentIntent } from "@/lib/idempotentIntent";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

export type Candidate = {
  userId: string;
  name: string;
  distanceMiles: number | null;
  alreadyAssigned: boolean;
  conflictingShift?: boolean;
  availabilityKnown?: boolean;
  availabilityCovers?: boolean;
  meetsLicense?: boolean;
  effectiveLevel?: number;
  workedSiteBefore?: boolean;
  siteShiftCount?: number;
};

export type AssignNearestResult = {
  topCandidate: { userId: string; name: string; distanceMiles: number | null } | null;
  candidates: Candidate[];
  assignment?: { id: string; shiftId: string; employeeId: string };
  assignedTo?: { userId: string; name: string };
  siteHasCoords?: boolean;
};

export function candidateBlockReason(c: Candidate): string | null {
  if (c.alreadyAssigned) return "already on this shift";
  if (c.conflictingShift) return "would double-book another shift";
  if (c.availabilityKnown && c.availabilityCovers === false) {
    return "outside stated availability";
  }
  return null;
}

export function AssignNearestDialog({
  shiftId, open, onOpenChange, onAssigned,
}: { shiftId: string; open: boolean; onOpenChange: (v: boolean) => void; onAssigned: () => void }) {
  const [result, setResult] = useState<AssignNearestResult | null>(null);
  // Override the license-level requirement: surfaces under-licensed officers
  // (flagged, sunk below qualified ones) and skips the clearance check on
  // assignment. Audit-logged server-side. Conflict / availability guards stay.
  const [override, setOverride] = useState(false);
  const [search, setSearch] = useState("");
  const dryRun = useMutation({
    mutationFn: (overrideLicense: boolean) => api<AssignNearestResult>("/dispatch/assign-nearest", {
      method: "POST",
      body: { shiftId, dryRun: true, overrideLicense },
    }),
    onSuccess: (data) => setResult(data),
  });
  // Rostering this officer onto this shift is one intent however many times
  // the button is pressed: a second press reuses the same idempotency key, so
  // the server replays the first assignment instead of answering "already
  // assigned" (which reads as a refusal) or creating a second row.
  const intent = useIdempotentIntent();
  const assign = useMutation({
    mutationFn: ({ employeeId, overrideLicense }: { employeeId: string; overrideLicense: boolean }) =>
      intent.run(`assign:${shiftId}:${employeeId}`, (idempotencyKey) =>
        api(`/shifts/${shiftId}/assignments`, {
          method: "POST",
          idempotencyKey,
          body: { employeeId, status: "accepted", overrideLicense },
        }),
      ),
    onSuccess: () => { onAssigned(); onOpenChange(false); },
    onError: (e) => {
      // Still-processing means the assignment is mid-save, not refused. Pull
      // the candidate list again: if it landed while we were waiting, this
      // officer comes back marked as already assigned, which is the answer.
      if (isStillProcessing(e)) dryRun.mutate(override);
    },
  });
  // Shown after `api()` has spent its joining budget without the server
  // confirming. Not a failure — the write may still land — so the buttons stay
  // usable (pressing again reuses the key and can only replay, never duplicate)
  // and no "could not assign" is claimed over a write that is committing.
  const stillSaving = assign.isError && isStillProcessing(assign.error);

  useEffect(() => {
    if (open) { setResult(null); setOverride(false); setSearch(""); assign.reset(); dryRun.mutate(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleOverride = (next: boolean) => {
    setOverride(next);
    setResult(null);
    dryRun.mutate(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{override ? "Assign nearest officer (license override)" : "Assign nearest qualified officer"}</DialogTitle>
          <DialogDescription className="sr-only">
            Rank available officers by distance from the site and assign one to fill this shift.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-xs cursor-pointer rounded border px-2 py-1.5 bg-amber-50 border-amber-200">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => toggleOverride(e.target.checked)}
            disabled={dryRun.isPending || assign.isPending}
          />
          <span>
            Override license-level requirement
            <span className="block text-[11px] text-amber-700">
              Surfaces under-licensed officers and skips the clearance check. Audit-logged.
            </span>
          </span>
        </label>
        <div className="space-y-2 text-sm">
          {dryRun.isPending && <div className="opacity-60">Ranking candidates…</div>}
          {dryRun.isError && (
            <div className="text-xs text-red-700">
              {dryRun.error instanceof Error ? dryRun.error.message : "Could not rank candidates."}
            </div>
          )}
          {result && result.candidates.length === 0 && (
            <div className="opacity-70">
              {override ? "No officers available." : "No qualified officers available."}
            </div>
          )}
          {result && !result.siteHasCoords && (
            <div className="text-xs p-2 bg-amber-100 text-amber-900 rounded">
              Site has no coordinates — ranking falls back to most-recent location ping.
            </div>
          )}
          {result && result.candidates.length > 0 && (
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search officers by name…"
              aria-label="Search officers by name"
              className="w-full rounded border px-2 py-1.5 text-sm"
            />
          )}
          {(() => {
            if (!result) return null;
            const q = search.trim().toLowerCase();
            // No search: show the nearest 8 (the smart default). With a search
            // term: filter the full ranked roster so any officer is reachable.
            const matches = q
              ? result.candidates.filter((c) => c.name.toLowerCase().includes(q))
              : result.candidates.slice(0, 8);
            if (q && matches.length === 0) {
              return <div className="text-xs opacity-60">No officers match “{search.trim()}”.</div>;
            }
            const rankByUser = new Map(result.candidates.map((c, i) => [c.userId, i + 1]));
            return matches.map((c) => {
              const rank = rankByUser.get(c.userId) ?? 0;
              const reason = candidateBlockReason(c);
              const disabled = !!reason;
              const underLicensed = c.meetsLicense === false;
              const recommended = result.topCandidate?.userId === c.userId;
              return (
                <div key={c.userId} className="flex items-center justify-between rounded border px-2 py-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs opacity-50 w-5">{rank}.</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 truncate">
                        {c.workedSiteBefore && (
                          <span className="text-amber-500 shrink-0 text-sm leading-none" title="Has worked this site before">★</span>
                        )}
                        <span className="truncate">{c.name}</span>
                      </div>
                      {underLicensed && (
                        <div className="text-[11px] text-amber-700 truncate">
                          ⚠ under required license{c.effectiveLevel != null ? ` (L${c.effectiveLevel})` : ""}
                        </div>
                      )}
                      {reason && (
                        <div className="text-[11px] text-amber-700 truncate">{reason}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs opacity-70 whitespace-nowrap">
                      {c.distanceMiles == null ? "no GPS" : `${c.distanceMiles.toFixed(1)} mi`}
                    </span>
                    <Button
                      size="sm"
                      variant={recommended && !disabled && !underLicensed ? "default" : "outline"}
                      disabled={disabled || assign.isPending}
                      onClick={() => assign.mutate({ employeeId: c.userId, overrideLicense: override })}
                    >
                      {assign.isPending ? "Saving…" : "Assign"}
                    </Button>
                  </div>
                </div>
              );
            });
          })()}
          {result && !search.trim() && result.candidates.length > 8 && (
            <div className="text-[11px] opacity-60">
              Showing nearest 8 of {result.candidates.length}. Search to find a specific officer.
            </div>
          )}
          {stillSaving && (
            <div role="status" className="text-xs text-muted-foreground">
              {STILL_SAVING_MESSAGE}
            </div>
          )}
          {assign.isError && !stillSaving && (
            <div className="text-xs text-red-700">
              {assign.error instanceof Error ? assign.error.message : "Could not assign officer."}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
