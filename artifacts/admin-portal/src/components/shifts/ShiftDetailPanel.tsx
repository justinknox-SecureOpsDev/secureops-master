import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api } from "@/lib/api";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Clock, MapPin, Users, Megaphone, UserPlus, Pencil, Repeat,
  Ban, Trash2, Shield, Check, X, Loader2, DollarSign,
} from "lucide-react";
import { AssignNearestDialog } from "@/components/AssignNearestDialog";
import {
  Shift, filledCount, fmtDateLongTz, fmtTimeTz, levelBadge, statusBadge,
  siteLabelFor, describeRepeatPattern,
} from "./shared";

type Props = {
  shiftId: string | null;
  open: boolean;
  onOpenChange: (b: boolean) => void;
  siteIndex: Map<string, { name: string; clientName: string | null }>;
  onEdit: (s: Shift) => void;
  onEditSeries: (s: Shift) => void;
  onDelete: (s: Shift) => void;
  onChanged: () => void;
};

export function ShiftDetailPanel({
  shiftId, open, onOpenChange, siteIndex, onEdit, onEditSeries, onDelete, onChanged,
}: Props) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [assignOpen, setAssignOpen] = useState(false);
  const [notifyMsg, setNotifyMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const detail = useQuery<Shift>({
    queryKey: ["shifts-area", "detail", shiftId],
    queryFn: () => api<Shift>(`/shifts/${shiftId}`),
    enabled: open && !!shiftId,
  });
  const shift = detail.data ?? null;

  const notifyMutation = useMutation({
    mutationFn: (shiftId: string) =>
      api<{ notified: number }>(`/shifts/${shiftId}/notify-vacancy`, { method: "POST", body: {} }),
    onSuccess: (r) => setNotifyMsg(`Notified ${r.notified} eligible officer${r.notified === 1 ? "" : "s"}.`),
    onError: (e) => setActionErr(e instanceof Error ? e.message : "Could not notify officers."),
  });

  const cancelMutation = useMutation({
    mutationFn: (shiftId: string) =>
      api(`/shifts/${shiftId}`, { method: "PUT", body: { status: "cancelled" } }),
    onSuccess: () => { onChanged(); },
    onError: (e) => setActionErr(e instanceof Error ? e.message : "Could not cancel shift."),
  });

  const claimMutation = useMutation({
    mutationFn: ({ shiftId, assignmentId, status }: { shiftId: string; assignmentId: string; status: "accepted" | "declined" }) =>
      api(`/shifts/${shiftId}/assignments/${assignmentId}`, { method: "PUT", body: { status } }),
    onSuccess: () => { onChanged(); qc.invalidateQueries({ queryKey: ["shifts-area"] }); },
    onError: (e) => setActionErr(e instanceof Error ? e.message : "Could not update claim."),
  });

  // Loading state: show the sheet immediately with a lightweight skeleton so
  // slower networks still get instant visual feedback when a shift is opened.
  if (!shift) {
    if (!shiftId) return null;
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto p-0">
          <div className="p-5 space-y-4" aria-busy="true">
            <SheetHeader className="space-y-2 text-left">
              <SheetTitle>Loading shift…</SheetTitle>
              <SheetDescription className="sr-only">Shift details are loading</SheetDescription>
            </SheetHeader>
            <div className="space-y-3 animate-pulse">
              <div className="h-5 w-2/3 rounded bg-muted" />
              <div className="h-4 w-1/2 rounded bg-muted" />
              <div className="h-24 rounded bg-muted" />
              <div className="h-4 w-3/4 rounded bg-muted" />
              <div className="h-16 rounded bg-muted" />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  const filled = filledCount(shift);
  const openSlots = Math.max(0, shift.headcount - filled);
  const lvl = levelBadge(shift.requiredLicenseLevel);
  const { site, client } = siteLabelFor(shift, siteIndex);
  const accepted = (shift.assignments ?? []).filter((a) => a.status === "accepted");
  const pending = (shift.assignments ?? []).filter((a) => a.status === "pending_approval");
  const patternDesc = shift.isRepeat ? describeRepeatPattern(shift.repeatPattern) : null;
  const isCancelled = shift.status === "cancelled";

  return (
    <Sheet open={open} onOpenChange={(b) => { if (!b) { setNotifyMsg(null); setActionErr(null); } onOpenChange(b); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto p-0">
        <div className="p-5 space-y-5">
          <SheetHeader className="space-y-2 text-left">
            <SheetTitle className="flex items-start gap-2 pr-6">
              <span className="flex-1">{shift.title}</span>
              {shift.isRepeat && <Repeat className="w-4 h-4 mt-1 text-brand-gold shrink-0" aria-label="Repeating series" />}
            </SheetTitle>
            <SheetDescription className="sr-only">Shift details and actions</SheetDescription>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className={statusBadge(shift.status)}>{shift.status}</Badge>
              {shift.positionName && (
                <Badge variant="outline" className="bg-brand-cream/60 text-brand-navy border-brand-gold/50">
                  {shift.positionName}
                </Badge>
              )}
              <Badge variant="outline" className={lvl.cls}>{lvl.label}</Badge>
              {shift.shiftType === "ppo_detail" && (
                <Badge variant="outline" className="bg-indigo-100 text-indigo-800 border-indigo-300">PPO Detail</Badge>
              )}
              {openSlots > 0 && !isCancelled ? (
                <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-300">
                  {openSlots} open slot{openSlots === 1 ? "" : "s"}
                </Badge>
              ) : !isCancelled ? (
                <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-300">Fully staffed</Badge>
              ) : null}
            </div>
          </SheetHeader>

          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <Clock className="w-4 h-4 mt-0.5 opacity-50 shrink-0" />
              <div>
                <div>{fmtDateLongTz(shift.startTime)}</div>
                <div className="opacity-70">{fmtTimeTz(shift.startTime)} – {fmtTimeTz(shift.endTime)} CT</div>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <MapPin className="w-4 h-4 mt-0.5 opacity-50 shrink-0" />
              <div>
                <div>{site}</div>
                {client && <div className="opacity-70">{client}</div>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 opacity-50 shrink-0" />
              <span>{filled}/{shift.headcount} staffed</span>
            </div>
            {(Number(shift.payRate) > 0 || Number(shift.billRate) > 0) && (
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 opacity-50 shrink-0" />
                <span>
                  Pay ${Number(shift.payRate || 0).toFixed(2)}/hr
                  {Number(shift.billRate) > 0 && <> · Bill ${Number(shift.billRate).toFixed(2)}/hr</>}
                </span>
              </div>
            )}
            {patternDesc && (
              <div className="flex items-center gap-2">
                <Repeat className="w-4 h-4 opacity-50 shrink-0" />
                <span className="opacity-80">Repeats: {patternDesc}</span>
              </div>
            )}
            {shift.notes && (
              <div className="rounded border bg-muted/40 px-3 py-2 text-xs whitespace-pre-wrap">{shift.notes}</div>
            )}
          </div>

          {/* Roster */}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-1.5">Assigned officers</div>
            {accepted.length === 0 ? (
              <div className="text-sm opacity-60">No officers assigned yet.</div>
            ) : (
              <ul className="space-y-1">
                {accepted.map((a) => (
                  <li key={a.id} className="text-sm flex items-center gap-2">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    {a.employeeName ?? "Unknown officer"}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Pending claims */}
          {pending.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-amber-800 mb-2">
                Pending claims ({pending.length})
              </div>
              <ul className="space-y-2">
                {pending.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-sm">
                    <span className="flex-1">{a.employeeName ?? "Unknown officer"}</span>
                    <Button
                      size="sm" className="h-7 bg-emerald-600 hover:bg-emerald-700 text-white"
                      disabled={claimMutation.isPending}
                      onClick={() => claimMutation.mutate({ shiftId: shift.id, assignmentId: a.id, status: "accepted" })}
                    >
                      <Check className="w-3.5 h-3.5 mr-1" /> Approve
                    </Button>
                    <Button
                      size="sm" variant="outline" className="h-7"
                      disabled={claimMutation.isPending}
                      onClick={() => claimMutation.mutate({ shiftId: shift.id, assignmentId: a.id, status: "declined" })}
                    >
                      <X className="w-3.5 h-3.5 mr-1" /> Decline
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {notifyMsg && (
            <div className="text-sm text-emerald-700 rounded border border-emerald-200 bg-emerald-50 px-3 py-2">{notifyMsg}</div>
          )}
          {actionErr && (
            <div className="text-sm text-red-700 rounded border border-red-200 bg-red-50 px-3 py-2">{actionErr}</div>
          )}

          {/* Actions */}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" onClick={() => onEdit(shift)}>
              <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit shift
            </Button>
            {shift.isRepeat && (
              <Button variant="outline" size="sm" onClick={() => onEditSeries(shift)}>
                <Repeat className="w-3.5 h-3.5 mr-1.5" /> Edit series
              </Button>
            )}
            {!isCancelled && (
              <>
                <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
                  <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Assign officer
                </Button>
                {openSlots > 0 && (
                  <Button
                    variant="outline" size="sm"
                    disabled={notifyMutation.isPending}
                    onClick={() => { setNotifyMsg(null); setActionErr(null); notifyMutation.mutate(shift.id); }}
                  >
                    {notifyMutation.isPending
                      ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      : <Megaphone className="w-3.5 h-3.5 mr-1.5" />}
                    Notify officers
                  </Button>
                )}
              </>
            )}
            {shift.shiftType === "ppo_detail" && (
              <Button variant="outline" size="sm" onClick={() => navigate(`/shifts/${shift.id}/protection`)}>
                <Shield className="w-3.5 h-3.5 mr-1.5" /> Protection detail
              </Button>
            )}
            {!isCancelled && (
              <Button
                variant="outline" size="sm"
                className="text-amber-700 border-amber-300 hover:bg-amber-50"
                disabled={cancelMutation.isPending}
                onClick={() => {
                  if (window.confirm("Cancel this shift? Officers will no longer see it as available.")) {
                    setActionErr(null);
                    cancelMutation.mutate(shift.id);
                  }
                }}
              >
                <Ban className="w-3.5 h-3.5 mr-1.5" /> Cancel shift
              </Button>
            )}
            <Button
              variant="outline" size="sm"
              className="text-red-600 border-red-300 hover:bg-red-50"
              onClick={() => onDelete(shift)}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete
            </Button>
          </div>
        </div>

        <AssignNearestDialog
          open={assignOpen}
          onOpenChange={setAssignOpen}
          shiftId={shift.id}
          onAssigned={onChanged}
        />
      </SheetContent>
    </Sheet>
  );
}
