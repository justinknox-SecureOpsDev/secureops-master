import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loader2, IdCard, Check, X, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  LICENSE_REMINDER_TIER_DAYS,
  formatReminderTierDaysList,
} from "@workspace/license-reminder-schedule";

type RenewalRow = {
  id: string;
  employeeId: string;
  licenseId: string | null;
  licenseType: string;
  licenseLevel: number | null;
  licenseNumber: string;
  issuingAuthority: string | null;
  issueDate: string | null;
  expiryDate: string;
  docKey: string;
  notes: string | null;
  status: "pending" | "approved" | "rejected";
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  employeeFirstName: string | null;
  employeeLastName: string | null;
  employeeEmail: string | null;
};

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900 border-amber-300",
  approved: "bg-emerald-100 text-emerald-900 border-emerald-300",
  rejected: "bg-red-100 text-red-900 border-red-300",
};

export default function LicenseRenewalsPage() {
  const [rows, setRows] = useState<RenewalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<RenewalRow[]>("/admin/license-renewals");
      setRows(data);
    } catch (err) {
      toast({ title: "Could not load renewals", description: (err as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function viewDoc(r: RenewalRow) {
    try {
      const { url } = await api<{ url: string }>(`/admin/storage/sign?path=${encodeURIComponent(r.docKey)}`);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast({ title: "Could not load document", description: (err as Error).message, variant: "destructive" });
    }
  }

  async function approve(r: RenewalRow) {
    setBusy(r.id);
    try {
      await api(`/admin/license-renewals/${r.id}/approve`, { method: "POST", body: JSON.stringify({}) });
      toast({ title: "Renewal approved", description: "The officer's license has been updated." });
      await refresh();
    } catch (err) {
      toast({ title: "Approve failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function reject(r: RenewalRow) {
    const reason = window.prompt("Reason for rejection (officer will see this):", "");
    if (!reason || !reason.trim()) return;
    setBusy(r.id);
    try {
      await api(`/admin/license-renewals/${r.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ decisionNote: reason.trim() }),
      });
      toast({ title: "Renewal rejected" });
      await refresh();
    } catch (err) {
      toast({ title: "Reject failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <IdCard className="w-5 h-5 brand-navy" />
        <h1 className="text-xl brand-wordmark brand-navy">License renewals</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Officers submit renewed license details + a photo from the mobile app. Approving here
        updates the underlying license row and clears its reminder bookkeeping so the new
        expiry restarts the reminder cycle. Officers are reminded at{" "}
        {formatReminderTierDaysList(LICENSE_REMINDER_TIER_DAYS)} before a license expires.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No renewals submitted yet.</div>
      ) : (
        <div className="border rounded-lg overflow-x-auto bg-white" tabIndex={0} role="region" aria-label="License renewals table">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Officer</th>
                <th className="text-left px-3 py-2">License</th>
                <th className="text-left px-3 py-2">New expiry</th>
                <th className="text-left px-3 py-2">Submitted</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <span className={`inline-block text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm border ${STATUS_TONE[r.status] || "bg-zinc-100 border-zinc-300"}`}>
                      {r.status}
                    </span>
                    {r.decisionNote && (
                      <div className="text-[11px] text-muted-foreground mt-1 max-w-xs">{r.decisionNote}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.employeeFirstName} {r.employeeLastName}</div>
                    <div className="text-xs text-muted-foreground">{r.employeeEmail}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">
                      {r.licenseType}
                      {r.licenseLevel != null && <span className="ml-1 brand-gold">[L{r.licenseLevel}]</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">#{r.licenseNumber}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.licenseId ? "Renews existing license" : "New license"}
                    </div>
                    {r.notes && <div className="text-[11px] text-muted-foreground mt-1 max-w-xs">"{r.notes}"</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div>{r.expiryDate}</div>
                    {r.issueDate && <div className="text-muted-foreground">issued {r.issueDate}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2 flex-wrap">
                      <Button size="sm" variant="outline" onClick={() => viewDoc(r)}>
                        <ExternalLink className="w-3 h-3 mr-1" />Photo
                      </Button>
                      {r.status === "pending" && (
                        <>
                          <Button size="sm" disabled={busy === r.id}
                            onClick={() => approve(r)}
                            className="bg-emerald-700 hover:bg-emerald-800 text-white">
                            {busy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3 mr-1" />}
                            Approve
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy === r.id}
                            onClick={() => reject(r)}>
                            <X className="w-3 h-3 mr-1" />Reject
                          </Button>
                        </>
                      )}
                    </div>
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
