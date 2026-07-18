import { useEffect, useState, useCallback } from "react";
import { useRoute } from "wouter";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Link2, Loader2, Copy, Ban, ExternalLink, Plus } from "lucide-react";

type ShareLink = {
  id: string;
  incidentId: string;
  token: string;
  recipientLabel: string | null;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  incidentTitle: string | null;
  incidentSeverity: string | null;
  incidentOccurredAt: string | null;
  createdByName: string | null;
  url: string;
};

type IncidentLite = { id: string; title: string; severity: string; occurredAt: string };

function statusOf(r: ShareLink): { label: string; tone: string } {
  if (r.revokedAt) return { label: "REVOKED", tone: "bg-zinc-200 text-zinc-700 border-zinc-300" };
  if (new Date(r.expiresAt).getTime() < Date.now())
    return { label: "EXPIRED", tone: "bg-zinc-200 text-zinc-700 border-zinc-300" };
  return { label: "ACTIVE", tone: "bg-emerald-100 text-emerald-900 border-emerald-300" };
}

export default function IncidentShareLinksPage() {
  const { toast } = useToast();
  // Optional `?incidentId=...` filter via the URL.
  const [, params] = useRoute("/incidents/share-links");
  const filterIncidentId = (() => {
    if (typeof window === "undefined") return null;
    const u = new URL(window.location.href);
    return u.searchParams.get("incidentId");
  })();
  void params;

  const [rows, setRows] = useState<ShareLink[]>([]);
  const [incidents, setIncidents] = useState<IncidentLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [pickIncidentId, setPickIncidentId] = useState<string>("");
  const [recipientLabel, setRecipientLabel] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("30");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filterIncidentId ? `?incidentId=${encodeURIComponent(filterIncidentId)}` : "";
      const [links, incs] = await Promise.all([
        api<ShareLink[]>(`/admin/incident-shares${qs}`),
        api<IncidentLite[]>(`/incidents`),
      ]);
      setRows(links);
      setIncidents(incs);
      if (filterIncidentId && !pickIncidentId) setPickIncidentId(filterIncidentId);
    } catch (e) {
      toast({ title: "Could not load share links", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast, filterIncidentId, pickIncidentId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function create() {
    if (!pickIncidentId) { toast({ title: "Pick an incident first" }); return; }
    const days = Number(expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      toast({ title: "Expiry must be between 1 and 365 days", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const created = await api<ShareLink>(`/admin/incidents/${pickIncidentId}/share`, {
        method: "POST",
        body: JSON.stringify({ expiresInDays: days, recipientLabel: recipientLabel.trim() || null }),
      });
      await navigator.clipboard?.writeText(created.url).catch(() => {});
      toast({ title: "Share link created", description: "URL copied to clipboard." });
      setRecipientLabel("");
      await refresh();
    } catch (e) {
      toast({ title: "Could not create link", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Copied", description: "Share URL copied to clipboard." });
    } catch {
      toast({ title: "Copy failed", description: "Select the URL and copy manually.", variant: "destructive" });
    }
  }

  async function revoke(r: ShareLink) {
    if (!window.confirm(`Revoke link${r.recipientLabel ? ` for ${r.recipientLabel}` : ""}? Anyone with the URL will be locked out immediately.`)) return;
    setBusy(r.id);
    try {
      await api(`/admin/incident-shares/${r.id}/revoke`, { method: "POST", body: JSON.stringify({}) });
      toast({ title: "Link revoked" });
      await refresh();
    } catch (e) {
      toast({ title: "Revoke failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <Link2 className="w-5 h-5 brand-navy" />
        <h1 className="text-xl brand-wordmark brand-navy">Incident share links</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-4 max-w-2xl">
        Mint a no-login link to share a single incident report with a client contact. Each
        link expires (default 30 days), can be revoked instantly, and tracks view count.
        Recipients see a sanitized read-only summary plus the PDF and signed attachments —
        no internal admin notes, no employee contact info.
      </p>

      <div className="bg-white border rounded-lg p-4 mb-6 max-w-3xl">
        <div className="text-sm font-semibold mb-3 brand-navy">Create a new link</div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div className="md:col-span-2">
            <label htmlFor="share-incident" className="text-xs text-muted-foreground">Incident</label>
            <select
              id="share-incident"
              value={pickIncidentId}
              onChange={(e) => setPickIncidentId(e.target.value)}
              className="w-full mt-1 border rounded-md px-2 py-2 text-sm bg-white"
            >
              <option value="">— pick an incident —</option>
              {incidents.map((i) => (
                <option key={i.id} value={i.id}>
                  {new Date(i.occurredAt).toLocaleDateString()} · {i.severity.toUpperCase()} · {i.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="share-recipient" className="text-xs text-muted-foreground">Recipient label (optional)</label>
            <Input id="share-recipient" value={recipientLabel} onChange={(e) => setRecipientLabel(e.target.value)}
              placeholder="e.g. Acme Mall — Janet Park" />
          </div>
          <div>
            <label htmlFor="share-expires" className="text-xs text-muted-foreground">Expires in (days)</label>
            <Input id="share-expires" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)}
              inputMode="numeric" />
          </div>
        </div>
        <div className="mt-3">
          <Button onClick={create} disabled={submitting}>
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
            Create & copy URL
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No share links yet.</div>
      ) : (
        <div className="border rounded-lg overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Incident</th>
                <th className="text-left px-3 py-2">Recipient</th>
                <th className="text-left px-3 py-2">Expires</th>
                <th className="text-left px-3 py-2">Views</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = statusOf(r);
                const isActive = s.label === "ACTIVE";
                return (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-3 py-2">
                      <span className={`inline-block text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm border ${s.tone}`}>
                        {s.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.incidentTitle ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.incidentSeverity?.toUpperCase()} · {r.incidentOccurredAt ? new Date(r.incidentOccurredAt).toLocaleDateString() : "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div>{r.recipientLabel ?? <span className="text-muted-foreground italic">—</span>}</div>
                      <div className="text-xs text-muted-foreground">by {r.createdByName ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">{new Date(r.expiresAt).toLocaleDateString()}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.viewCount}
                      {r.lastViewedAt && (
                        <div className="text-muted-foreground">last {new Date(r.lastViewedAt).toLocaleString()}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-2 flex-wrap">
                        <Button size="sm" variant="outline" onClick={() => copy(r.url)}>
                          <Copy className="w-3 h-3 mr-1" />Copy
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => window.open(r.url, "_blank", "noopener,noreferrer")}>
                          <ExternalLink className="w-3 h-3 mr-1" />Open
                        </Button>
                        {isActive && (
                          <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => revoke(r)}>
                            {busy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3 mr-1" />}
                            Revoke
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
