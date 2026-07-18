import { useEffect, useState } from "react";
import { CalendarClock, CheckCircle2, XCircle, Clock3, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type CoverageRequest = {
  id: string;
  clientId: string;
  clientName: string | null;
  siteId: string;
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
  createdShiftIds: string[] | null;
};

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const STATUS_CFG: Record<string, { cls: string; icon: React.ReactNode; label: string }> = {
  pending: { cls: "bg-amber-100 text-amber-700", icon: <Clock3 className="w-3 h-3" />, label: "Pending" },
  approved: { cls: "bg-green-100 text-green-700", icon: <CheckCircle2 className="w-3 h-3" />, label: "Approved" },
  declined: { cls: "bg-red-100 text-red-700", icon: <XCircle className="w-3 h-3" />, label: "Declined" },
};

function StatusBadge({ status }: { status: string }) {
  const { cls, icon, label } = STATUS_CFG[status] ?? { cls: "bg-gray-100 text-gray-500", icon: null, label: status };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${cls}`}>
      {icon}{label}
    </span>
  );
}

function ReviewPanel({
  id,
  onDone,
}: {
  id: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  async function act(action: "approve" | "decline") {
    setLoading(true);
    try {
      await api(`/admin/shift-requests/${id}/${action}`, {
        method: "POST",
        body: { adminNote: note || undefined },
      });
      toast({
        title: action === "approve"
          ? "Request approved — shifts created."
          : "Request declined.",
      });
      onDone();
    } catch (err: any) {
      toast({ title: err?.message ?? `Failed to ${action}.`, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border-t px-4 py-4 bg-muted/20 space-y-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Note to client (optional)</label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Optional message for the client…"
          maxLength={2000}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="gap-1 bg-green-600 hover:bg-green-700 text-white"
          onClick={() => act("approve")}
          disabled={loading}
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          {loading ? "Processing…" : "Approve & create shifts"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1 text-red-600 border-red-200 hover:bg-red-50"
          onClick={() => act("decline")}
          disabled={loading}
        >
          <XCircle className="w-3.5 h-3.5" /> Decline
        </Button>
      </div>
    </div>
  );
}

function RequestRow({ req, onRefresh }: { req: CoverageRequest; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const dayCount = req.startDate === req.endDate
    ? 1
    : Math.round((new Date(req.endDate).getTime() - new Date(req.startDate).getTime()) / 86_400_000) + 1;

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      <div
        className="flex items-start gap-4 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((e) => !e)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((x) => !x)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{req.clientName ?? "Client"}</span>
            <span className="text-muted-foreground text-xs">·</span>
            <span className="text-sm text-muted-foreground">{req.siteName ?? "Site"}</span>
            <StatusBadge status={req.status} />
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>
              {req.startDate === req.endDate
                ? fmt(req.startDate)
                : `${fmt(req.startDate)} – ${fmt(req.endDate)} (${dayCount} days)`}
            </span>
            <span>{req.startTime} – {req.endTime}</span>
            <span>
              {[req.l2Count > 0 && `${req.l2Count}×L2`, req.l3Count > 0 && `${req.l3Count}×L3`, req.l4Count > 0 && `${req.l4Count}×L4`].filter(Boolean).join(", ")}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">Submitted {fmt(req.createdAt)}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {req.status === "approved" && req.createdShiftIds && (
            <span className="text-xs text-green-600 font-medium">{req.createdShiftIds.length} shifts created</span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <>
          {/* Detail */}
          <div className="border-t px-4 py-3 bg-muted/10 text-sm space-y-2">
            {req.notes && <p className="text-muted-foreground"><strong>Notes:</strong> {req.notes}</p>}
            {req.adminNote && (
              <p><strong>Admin note:</strong> {req.adminNote}</p>
            )}
            {req.reviewedAt && (
              <p className="text-xs text-muted-foreground">Reviewed {fmtTime(req.reviewedAt)}</p>
            )}
          </div>
          {/* Action panel for pending only */}
          {req.status === "pending" && (
            <ReviewPanel id={req.id} onDone={() => { setExpanded(false); onRefresh(); }} />
          )}
        </>
      )}
    </div>
  );
}

type FilterStatus = "all" | "pending" | "approved" | "declined";

export default function CoverageRequests() {
  const [requests, setRequests] = useState<CoverageRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterStatus>("pending");

  function refresh() {
    const q = filter !== "all" ? `?status=${filter}` : "";
    return api<CoverageRequest[]>(`/admin/shift-requests${q}`).then(setRequests);
  }

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [filter]);

  const counts = {
    pending: requests.filter((r) => r.status === "pending").length,
    approved: requests.filter((r) => r.status === "approved").length,
    declined: requests.filter((r) => r.status === "declined").length,
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-xl font-bold flex items-center gap-2 mb-6">
        <CalendarClock className="w-5 h-5" /> Coverage Requests
      </h1>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {(["pending", "approved", "declined", "all"] as FilterStatus[]).map((f) => {
          const count = f === "all" ? requests.length : counts[f as keyof typeof counts];
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded text-sm font-medium border transition-colors capitalize ${filter === f ? "bg-foreground text-background" : "hover:bg-muted"}`}
            >
              {f === "all" ? "All" : f}
              {f !== "all" && count !== undefined && (
                <span className="ml-1.5 bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px]">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <CalendarClock className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No {filter !== "all" ? filter : ""} coverage requests.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <RequestRow key={r.id} req={r} onRefresh={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}
