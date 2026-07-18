import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft, MapPin, Calendar, Plus, Copy, Loader2, Trash2, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  shiftboard, publicShareUrl,
  type ShiftboardShift, type ShiftboardSignup,
} from "@/lib/shiftboard";

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

function CoverageBar({ filled, total, label }: { filled: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((filled / total) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="opacity-70">{label ?? "Coverage"}</span>
        <span className="font-semibold">{filled}/{total} ({pct}%)</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className="h-full bg-brand-gold transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SignupRow({
  signup, onRemove, removing,
}: { signup: ShiftboardSignup; onRemove: () => void; removing: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs py-1 border-b last:border-0">
      <div className="min-w-0">
        <div className="font-medium truncate">{signup.name}</div>
        <div className="opacity-60 truncate">
          {signup.phone || "—"} {signup.email ? `· ${signup.email}` : ""}
        </div>
      </div>
      <Button
        variant="ghost" size="sm" className="text-red-600 hover:text-red-700 shrink-0"
        onClick={onRemove} disabled={removing}
        title="Remove signup"
      >
        {removing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
      </Button>
    </div>
  );
}

function ShiftRow({ shift, eventId }: { shift: ShiftboardShift; eventId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const filled = shift.signups.length;

  const removeMut = useMutation({
    mutationFn: (s: ShiftboardSignup) => shiftboard.deleteSignup(s.id, s.name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shiftboard", "event", eventId] });
      qc.invalidateQueries({ queryKey: ["shiftboard", "event-stats", eventId] });
      qc.invalidateQueries({ queryKey: ["shiftboard", "events"] });
      toast({ title: "Signup removed" });
    },
    onError: (e: Error) => toast({ title: "Remove failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="border rounded-md p-3 space-y-2 bg-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">{shift.position}</div>
          <div className="text-xs opacity-70">
            {shift.startTime}–{shift.endTime}
            {shift.role && <span> · {shift.role}</span>}
            {shift.posCode && <span> · {shift.posCode}</span>}
          </div>
        </div>
        <div className="text-xs font-semibold shrink-0">
          {filled}/{shift.slotsTotal}
        </div>
      </div>
      {shift.notes && <div className="text-xs opacity-70">{shift.notes}</div>}
      {shift.signups.length === 0 ? (
        <div className="text-[11px] opacity-50 italic">No signups yet</div>
      ) : (
        <div>
          {shift.signups.map((s) => (
            <SignupRow
              key={s.id}
              signup={s}
              onRemove={() => removeMut.mutate(s)}
              removing={removeMut.isPending && removeMut.variables?.id === s.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AddShiftDialog({ eventId, defaultDate }: { eventId: number; defaultDate?: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(defaultDate ?? "");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("16:00");
  const [position, setPosition] = useState("");
  const [area, setArea] = useState("");
  const [role, setRole] = useState("GRD");
  const [posCode, setPosCode] = useState("");
  const [slotsTotal, setSlotsTotal] = useState(1);
  const [notes, setNotes] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      shiftboard.addShift(eventId, {
        date, startTime, endTime, position: position.trim(),
        area: area.trim() || undefined,
        role: role.trim() || undefined,
        posCode: posCode.trim() || undefined,
        slotsTotal,
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shiftboard", "event", eventId] });
      qc.invalidateQueries({ queryKey: ["shiftboard", "event-stats", eventId] });
      qc.invalidateQueries({ queryKey: ["shiftboard", "events"] });
      toast({ title: "Shift added" });
      setOpen(false);
      setPosition(""); setArea(""); setPosCode(""); setSlotsTotal(1); setNotes("");
    },
    onError: (e: Error) => toast({ title: "Add failed", description: e.message, variant: "destructive" }),
  });

  const canSubmit = !!date && !!startTime && !!endTime && !!position.trim() && slotsTotal > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v && defaultDate) setDate(defaultDate); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><Plus className="w-4 h-4 mr-1" /> Add shift</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add shift</DialogTitle>
          <DialogDescription className="sr-only">
            Add a new shift slot to this staffing event.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div><Label>Date *</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div><Label>Start *</Label><Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></div>
            <div><Label>End *</Label><Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></div>
          </div>
          <div><Label>Position *</Label><Input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="e.g. GATE 10 SEARCH" /></div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div><Label>Area</Label><Input value={area} onChange={(e) => setArea(e.target.value)} placeholder="PERIM" /></div>
            <div><Label>Role</Label><Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="GRD / SUP / MGR" /></div>
            <div><Label>Slots *</Label><Input type="number" min={1} value={slotsTotal} onChange={(e) => setSlotsTotal(parseInt(e.target.value || "1"))} /></div>
          </div>
          <div><Label>Pos code</Label><Input value={posCode} onChange={(e) => setPosCode(e.target.value)} placeholder="B14, C14" /></div>
          <div><Label>Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={!canSubmit || mut.isPending}>
            {mut.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Add shift
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function StaffingEventPage() {
  const params = useParams<{ id: string }>();
  const eventId = Number(params.id);
  const { toast } = useToast();

  const full = useQuery({
    queryKey: ["shiftboard", "event", eventId],
    queryFn: () => shiftboard.getEventFull(eventId),
    enabled: Number.isFinite(eventId),
  });
  const stats = useQuery({
    queryKey: ["shiftboard", "event-stats", eventId],
    queryFn: () => shiftboard.getEventStats(eventId),
    enabled: Number.isFinite(eventId),
  });

  // Group shifts: date -> area -> shifts[]
  const grouped = useMemo(() => {
    const out = new Map<string, Map<string, ShiftboardShift[]>>();
    for (const s of full.data?.shifts ?? []) {
      if (!out.has(s.date)) out.set(s.date, new Map());
      const byArea = out.get(s.date)!;
      const areaKey = s.area || "—";
      if (!byArea.has(areaKey)) byArea.set(areaKey, []);
      byArea.get(areaKey)!.push(s);
    }
    for (const byArea of out.values()) {
      for (const list of byArea.values()) {
        list.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.position.localeCompare(b.position));
      }
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [full.data]);

  if (full.isLoading || stats.isLoading) {
    return <div className="p-6 text-sm opacity-70 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>;
  }
  if (full.error || stats.error) {
    return (
      <div className="p-6">
        <Link href="/staffing"><Button variant="ghost" size="sm"><ChevronLeft className="w-4 h-4 mr-1" /> Back</Button></Link>
        <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          Failed to load event: {((full.error || stats.error) as Error).message}
        </div>
      </div>
    );
  }
  if (!full.data || !stats.data) return null;

  const ev = full.data.event;
  const shareUrl = publicShareUrl(ev.slug);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast({ title: "Link copied", description: shareUrl });
    } catch {
      toast({ title: "Copy failed", description: shareUrl, variant: "destructive" });
    }
  };

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div>
        <Link href="/staffing"><Button variant="ghost" size="sm"><ChevronLeft className="w-4 h-4 mr-1" /> All events</Button></Link>
      </div>

      <div className="border rounded-lg p-5 bg-card space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold brand-wordmark">{ev.name}</h1>
            <div className="text-sm opacity-80 flex items-center gap-1 mt-1"><MapPin className="w-4 h-4" /> {ev.location}</div>
            <div className="text-sm opacity-80 flex items-center gap-1 mt-0.5">
              <Calendar className="w-4 h-4" />
              {ev.startDate ? fmtDate(ev.startDate) : "—"} → {ev.endDate ? fmtDate(ev.endDate) : "—"}
            </div>
            {ev.description && <div className="text-sm opacity-80 mt-2">{ev.description}</div>}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={copyLink}><Copy className="w-4 h-4 mr-1" /> Copy link</Button>
            <a href={shareUrl} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm"><ExternalLink className="w-4 h-4 mr-1" /> Open public</Button>
            </a>
            <AddShiftDialog eventId={eventId} defaultDate={ev.startDate ?? undefined} />
          </div>
        </div>
        <div className="max-w-sm pt-1">
          <CoverageBar filled={stats.data.filledSlots} total={stats.data.totalSlots} label="Total coverage" />
        </div>
      </div>

      {stats.data.byDay.length > 0 && (
        <div className="border rounded-lg p-4 bg-card">
          <div className="text-sm font-semibold mb-3">Coverage by day</div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {stats.data.byDay.map((d) => (
              <div key={d.date} className="border rounded p-2 space-y-1">
                <div className="text-xs font-medium">{fmtDate(d.date)}</div>
                <CoverageBar filled={d.filledSlots} total={d.totalSlots} />
              </div>
            ))}
          </div>
        </div>
      )}

      {grouped.length === 0 ? (
        <div className="text-sm opacity-70 border rounded p-8 text-center">
          No shifts yet. Click <strong>Add shift</strong> to create the first one.
        </div>
      ) : (
        <div className="space-y-5">
          {grouped.map(([date, byArea]) => (
            <div key={date} className="space-y-3">
              <div className="text-base font-semibold sticky top-0 bg-background py-1 border-b">
                {fmtDate(date)}
              </div>
              <div className="space-y-4">
                {[...byArea.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([area, shifts]) => (
                  <div key={area} className="space-y-2">
                    <div className="text-xs uppercase tracking-widest opacity-60">{area}</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                      {shifts.map((s) => <ShiftRow key={s.id} shift={s} eventId={eventId} />)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
