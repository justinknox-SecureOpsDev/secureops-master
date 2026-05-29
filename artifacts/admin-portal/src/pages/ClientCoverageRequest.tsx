import { useEffect, useState } from "react";
import { CalendarClock, Plus, CheckCircle2, XCircle, Clock3 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type Site = { id: string; name: string; address: string | null };
type Request = {
  id: string;
  siteId: string | null;
  siteName: string | null;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  l2Count: number;
  l3Count: number;
  l4Count: number;
  notes: string | null;
  status: string;
  adminNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

function fmt(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  pending: <Clock3 className="w-4 h-4 text-amber-500" />,
  approved: <CheckCircle2 className="w-4 h-4 text-green-500" />,
  declined: <XCircle className="w-4 h-4 text-red-500" />,
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-amber-100 text-amber-700",
    approved: "bg-green-100 text-green-700",
    declined: "bg-red-100 text-red-700",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${map[status] ?? "bg-gray-100 text-gray-500"}`}>
      {STATUS_ICON[status]}
      {status}
    </span>
  );
}

export default function ClientCoverageRequest() {
  const { toast } = useToast();
  const [sites, setSites] = useState<Site[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    siteId: "",
    startDate: "",
    endDate: "",
    startTime: "08:00",
    endTime: "16:00",
    l2Count: 0,
    l3Count: 0,
    l4Count: 0,
    notes: "",
  });

  function refresh() {
    return Promise.all([
      api<Site[]>("/client/sites"),
      api<Request[]>("/client/shift-requests"),
    ]).then(([s, r]) => {
      setSites(s);
      setRequests(r);
    });
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  function fld(k: keyof typeof form, v: string | number) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.siteId) { toast({ title: "Please select a site.", variant: "destructive" }); return; }
    if (form.l2Count + form.l3Count + form.l4Count === 0) {
      toast({ title: "Enter at least one officer count (L2/L3/L4).", variant: "destructive" });
      return;
    }
    if (form.startDate > form.endDate) {
      toast({ title: "End date must be on or after start date.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await api("/client/shift-requests", {
        method: "POST",
        body: {
          siteId: form.siteId,
          startDate: form.startDate,
          endDate: form.endDate || form.startDate,
          startTime: form.startTime,
          endTime: form.endTime,
          l2Count: form.l2Count,
          l3Count: form.l3Count,
          l4Count: form.l4Count,
          notes: form.notes || undefined,
        },
      });
      toast({ title: "Coverage request submitted. We'll review it shortly." });
      setShowForm(false);
      setForm({ siteId: "", startDate: "", endDate: "", startTime: "08:00", endTime: "16:00", l2Count: 0, l3Count: 0, l4Count: 0, notes: "" });
      await refresh();
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to submit request.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <CalendarClock className="w-5 h-5" /> Coverage Requests
        </h1>
        {!showForm && (
          <Button size="sm" onClick={() => setShowForm(true)} className="gap-1">
            <Plus className="w-4 h-4" /> Request Coverage
          </Button>
        )}
      </div>

      {showForm && (
        <form onSubmit={submit} className="border rounded-lg bg-card p-6 mb-8 space-y-5">
          <h2 className="text-base font-semibold">New Coverage Request</h2>

          <div className="space-y-1">
            <Label htmlFor="site">Site *</Label>
            <select
              id="site"
              required
              value={form.siteId}
              onChange={(e) => fld("siteId", e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm bg-background"
            >
              <option value="">Select a site…</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="startDate">From date *</Label>
              <Input id="startDate" type="date" required min={today} value={form.startDate} onChange={(e) => fld("startDate", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="endDate">To date</Label>
              <Input id="endDate" type="date" min={form.startDate || today} value={form.endDate} onChange={(e) => fld("endDate", e.target.value)} placeholder={form.startDate} />
              <p className="text-[10px] text-muted-foreground">Leave blank for single day.</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="startTime">Shift start *</Label>
              <Input id="startTime" type="time" required value={form.startTime} onChange={(e) => fld("startTime", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="endTime">Shift end *</Label>
              <Input id="endTime" type="time" required value={form.endTime} onChange={(e) => fld("endTime", e.target.value)} />
            </div>
          </div>

          <div>
            <Label className="mb-2 block">Officers required</Label>
            <div className="grid grid-cols-3 gap-4">
              {(["l2Count", "l3Count", "l4Count"] as const).map((key, i) => {
                const labels = ["L2 Unarmed", "L3 Armed", "L4/PPO"];
                return (
                  <div key={key} className="space-y-1">
                    <label className="text-xs text-muted-foreground">{labels[i]}</label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={form[key]}
                      onChange={(e) => fld(key, parseInt(e.target.value) || 0)}
                    />
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">Enter counts for each license level you need. At least one must be &gt; 0.</p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="notes">Additional notes</Label>
            <Textarea
              id="notes"
              value={form.notes}
              onChange={(e) => fld("notes", e.target.value)}
              placeholder="Special instructions, uniform requirements, access codes…"
              rows={3}
              maxLength={2000}
            />
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Submitting…" : "Submit request"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <CalendarClock className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No coverage requests yet.</p>
          {!showForm && (
            <Button size="sm" className="mt-4 gap-1" onClick={() => setShowForm(true)}>
              <Plus className="w-4 h-4" /> Submit your first request
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <div key={r.id} className="border rounded-lg bg-card px-4 py-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{r.siteName ?? "Site"}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>
                      {r.startDate === r.endDate ? fmt(r.startDate) : `${fmt(r.startDate)} – ${fmt(r.endDate)}`}
                    </span>
                    <span>{r.startTime} – {r.endTime}</span>
                    <span>
                      {[r.l2Count > 0 && `${r.l2Count}×L2`, r.l3Count > 0 && `${r.l3Count}×L3`, r.l4Count > 0 && `${r.l4Count}×L4`].filter(Boolean).join(", ")}
                    </span>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground shrink-0">{fmt(r.createdAt)}</div>
              </div>
              {r.notes && (
                <p className="text-xs text-muted-foreground mt-2 pt-2 border-t">{r.notes}</p>
              )}
              {r.adminNote && (
                <div className="mt-2 pt-2 border-t text-xs">
                  <span className="font-medium text-muted-foreground">Admin note: </span>
                  <span>{r.adminNote}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
