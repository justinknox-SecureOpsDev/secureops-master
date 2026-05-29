import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

export type Candidate = {
  userId: string;
  name: string;
  distanceMiles: number | null;
  alreadyAssigned: boolean;
  conflictingShift?: boolean;
  availabilityKnown?: boolean;
  availabilityCovers?: boolean;
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
  const dryRun = useMutation({
    mutationFn: () => api<AssignNearestResult>("/dispatch/assign-nearest", {
      method: "POST",
      body: { shiftId, dryRun: true },
    }),
    onSuccess: (data) => setResult(data),
  });
  const assign = useMutation({
    mutationFn: (employeeId: string) =>
      api(`/shifts/${shiftId}/assignments`, {
        method: "POST",
        body: { employeeId, status: "accepted" },
      }),
    onSuccess: () => { onAssigned(); onOpenChange(false); },
  });

  useEffect(() => {
    if (open) { setResult(null); assign.reset(); dryRun.mutate(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign nearest qualified officer</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {dryRun.isPending && <div className="opacity-60">Ranking candidates…</div>}
          {dryRun.isError && (
            <div className="text-xs text-red-700">
              {dryRun.error instanceof Error ? dryRun.error.message : "Could not rank candidates."}
            </div>
          )}
          {result && result.candidates.length === 0 && (
            <div className="opacity-70">No qualified officers available.</div>
          )}
          {result && !result.siteHasCoords && (
            <div className="text-xs p-2 bg-amber-100 text-amber-900 rounded">
              Site has no coordinates — ranking falls back to most-recent location ping.
            </div>
          )}
          {result?.candidates.slice(0, 8).map((c, idx) => {
            const reason = candidateBlockReason(c);
            const disabled = !!reason;
            return (
              <div key={c.userId} className="flex items-center justify-between rounded border px-2 py-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs opacity-50 w-5">{idx + 1}.</span>
                  <div className="min-w-0">
                    <div className="truncate">{c.name}</div>
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
                    variant={idx === 0 && !disabled ? "default" : "outline"}
                    disabled={disabled || assign.isPending}
                    onClick={() => assign.mutate(c.userId)}
                  >
                    Assign
                  </Button>
                </div>
              </div>
            );
          })}
          {assign.isError && (
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
