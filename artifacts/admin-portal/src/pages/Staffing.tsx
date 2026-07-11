import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, ExternalLink, Copy, Calendar, MapPin, Users, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { shiftboard, publicShareUrl, SHIFTBOARD_BASE_URL, type ShiftboardEvent } from "@/lib/shiftboard";

function fmtDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return "No dates set";
  const f = (s: string) => {
    const d = new Date(s + "T00:00:00Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  };
  if (start && end) return `${f(start)} → ${f(end)}`;
  return f((start || end)!);
}

function CoverageBar({ filled, total }: { filled: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((filled / total) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="opacity-70">Coverage</span>
        <span className="font-semibold">{filled}/{total} ({pct}%)</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-brand-gold transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function EventCard({ ev }: { ev: ShiftboardEvent }) {
  const { toast } = useToast();
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
    <div className="border rounded-lg bg-card p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold truncate">{ev.name}</div>
          <div className="text-xs opacity-70 flex items-center gap-1 mt-0.5">
            <MapPin className="w-3 h-3 shrink-0" /> {ev.location}
          </div>
          <div className="text-xs opacity-70 flex items-center gap-1 mt-0.5">
            <Calendar className="w-3 h-3 shrink-0" /> {fmtDateRange(ev.startDate, ev.endDate)}
          </div>
        </div>
        <div className="text-[10px] uppercase tracking-widest opacity-50 shrink-0 flex items-center gap-1">
          <Users className="w-3 h-3" /> {ev.totalShifts} shifts
        </div>
      </div>

      {ev.description && (
        <div className="text-xs opacity-80 line-clamp-2">{ev.description}</div>
      )}

      <CoverageBar filled={ev.filledSlots} total={ev.totalSlots} />

      <div className="flex gap-2 pt-1 flex-wrap">
        <Link href={`/staffing/${ev.id}`} className="flex-1 min-w-[120px]">
          <Button variant="default" size="sm" className="w-full">
            <ExternalLink className="w-4 h-4 mr-1" /> View
          </Button>
        </Link>
        <Button variant="outline" size="sm" onClick={copyLink} title={shareUrl}>
          <Copy className="w-4 h-4 mr-1" /> Copy link
        </Button>
      </div>
    </div>
  );
}

function NewEventDialog() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      shiftboard.createEvent({
        name: name.trim(),
        location: location.trim(),
        description: description.trim() || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shiftboard", "events"] });
      toast({ title: "Event created" });
      setOpen(false);
      setName(""); setLocation(""); setDescription(""); setStartDate(""); setEndDate("");
    },
    onError: (e: Error) => toast({ title: "Create failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="w-4 h-4 mr-1" /> New event</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New staffing event</DialogTitle>
          <DialogDescription className="sr-only">
            Create a new staffing event with its details.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label>Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. FIFA Dallas Fan Fest" />
          </div>
          <div>
            <Label>Location *</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Dallas, TX" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Start date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label>End date</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>Description</Label>
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !name.trim() || !location.trim()}>
            {mut.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function StaffingPage() {
  const q = useQuery({
    queryKey: ["shiftboard", "events"],
    queryFn: () => shiftboard.listEvents(),
    refetchOnWindowFocus: true,
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold brand-wordmark">Staffing</h1>
          <p className="text-sm opacity-70">
            Event-based scheduling. Powered by{" "}
            <a className="underline" href={SHIFTBOARD_BASE_URL} target="_blank" rel="noreferrer">ShiftBoard</a>.
          </p>
        </div>
        <NewEventDialog />
      </div>

      {q.isLoading && <div className="text-sm opacity-70 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading events…</div>}
      {q.error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          Failed to load events: {(q.error as Error).message}
        </div>
      )}

      {q.data && q.data.length === 0 && (
        <div className="text-sm opacity-70 border rounded p-8 text-center">
          No events yet. Click <strong>New event</strong> to create one.
        </div>
      )}

      {q.data && q.data.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {q.data.map((ev) => <EventCard key={ev.id} ev={ev} />)}
        </div>
      )}
    </div>
  );
}
