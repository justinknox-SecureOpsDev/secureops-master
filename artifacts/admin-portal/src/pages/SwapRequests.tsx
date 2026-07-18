import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loader2, Repeat, Check, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type SwapRow = {
  id: string;
  status: string;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  shift_id: string | null;
  start_time: string | null;
  end_time: string | null;
  required_license_level: string | null;
  site_name: string | null;
  requester_first_name: string | null;
  requester_last_name: string | null;
  target_first_name: string | null;
  target_last_name: string | null;
};

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900 border-amber-300",
  accepted: "bg-blue-100 text-blue-900 border-blue-300",
  approved: "bg-emerald-100 text-emerald-900 border-emerald-300",
  rejected: "bg-red-100 text-red-900 border-red-300",
  declined: "bg-red-50 text-red-800 border-red-200",
  cancelled: "bg-zinc-100 text-zinc-800 border-zinc-300",
};

export default function SwapRequestsPage() {
  const [rows, setRows] = useState<SwapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<SwapRow[]>("/admin/swap-requests");
      setRows(data);
    } catch (err) {
      toast({ title: "Could not load swaps", description: (err as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function decide(id: string, action: "approve" | "reject") {
    setBusy(id);
    try {
      await api(`/admin/swap-requests/${id}/${action}`, { method: "POST" });
      toast({ title: action === "approve" ? "Swap approved" : "Swap rejected" });
      await refresh();
    } catch (err) {
      toast({ title: "Action failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <Repeat className="w-5 h-5 brand-navy" />
        <h1 className="text-xl brand-wordmark brand-navy">Shift swap requests</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Officers may ask another qualifying officer to cover a shift. Once the target accepts,
        admin approval here moves the assignment atomically.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No swap requests yet.</div>
      ) : (
        <div className="border rounded-lg overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Shift</th>
                <th className="text-left px-3 py-2">From → To</th>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="text-left px-3 py-2">Submitted</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 align-top">
                    <span className={`inline-block text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm border ${STATUS_TONE[r.status] || "bg-zinc-100 border-zinc-300"}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium">{r.site_name || "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.start_time ? new Date(r.start_time).toLocaleString() : "—"}
                      {r.required_license_level && <span className="ml-2 brand-gold">[{r.required_license_level}]</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div>{r.requester_first_name} {r.requester_last_name}</div>
                    <div className="text-xs text-muted-foreground">→ {r.target_first_name} {r.target_last_name}</div>
                  </td>
                  <td className="px-3 py-2 align-top max-w-xs">
                    <div className="text-xs text-muted-foreground line-clamp-3">{r.reason || "—"}</div>
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 align-top text-right">
                    {r.status === "accepted" && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="default" disabled={busy === r.id}
                          onClick={() => decide(r.id, "approve")}
                          className="bg-emerald-700 hover:bg-emerald-800 text-white">
                          {busy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3 mr-1" />}
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy === r.id}
                          onClick={() => decide(r.id, "reject")}>
                          <X className="w-3 h-3 mr-1" />Reject
                        </Button>
                      </div>
                    )}
                    {r.status === "pending" && (
                      <Button size="sm" variant="outline" disabled={busy === r.id}
                        onClick={() => decide(r.id, "reject")}>
                        <X className="w-3 h-3 mr-1" />Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
