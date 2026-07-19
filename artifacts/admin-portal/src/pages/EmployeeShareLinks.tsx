import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Link2, Loader2, Copy, Ban, ExternalLink, Pencil } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  EmployeeShareSectionsField, DEFAULT_SECTIONS,
  type VisibleSections,
} from "@/components/EmployeeShareSectionsField";

type ShareLink = {
  id: string;
  employeeUserId: string;
  token: string;
  recipientLabel: string | null;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  visibleSections: VisibleSections | null;
  createdAt: string;
  officerFirstName: string | null;
  officerLastName: string | null;
  createdByName: string | null;
  url: string;
};

function statusOf(r: ShareLink): { label: string; tone: string } {
  if (r.revokedAt) return { label: "REVOKED", tone: "bg-zinc-200 text-zinc-700 border-zinc-300" };
  if (new Date(r.expiresAt).getTime() < Date.now())
    return { label: "EXPIRED", tone: "bg-zinc-200 text-zinc-700 border-zinc-300" };
  return { label: "ACTIVE", tone: "bg-emerald-100 text-emerald-900 border-emerald-300" };
}

/**
 * Admin list/management page for officer-profile share links. Mirrors
 * the incident-shares page. Mint flow lives in the Personnel row dialog
 * itself; this page is the audit + revoke surface.
 */
export default function EmployeeShareLinksPage() {
  const { toast } = useToast();
  const filterUserId = (() => {
    if (typeof window === "undefined") return null;
    return new URL(window.location.href).searchParams.get("employeeUserId");
  })();

  const [rows, setRows] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<ShareLink | null>(null);
  const [editSections, setEditSections] = useState<VisibleSections>({ ...DEFAULT_SECTIONS });
  const [savingEdit, setSavingEdit] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filterUserId ? `?employeeUserId=${encodeURIComponent(filterUserId)}` : "";
      const links = await api<ShareLink[]>(`/admin/employee-shares${qs}`);
      setRows(links);
    } catch (e) {
      toast({ title: "Could not load share links", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast, filterUserId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Copied", description: "Share URL copied to clipboard." });
    } catch {
      toast({ title: "Copy failed", description: "Select the URL and copy manually.", variant: "destructive" });
    }
  }

  function openEdit(r: ShareLink) {
    setEditing(r);
    setEditSections({ ...DEFAULT_SECTIONS, ...(r.visibleSections ?? {}) });
  }

  async function saveEdit() {
    if (!editing) return;
    setSavingEdit(true);
    try {
      await api(`/admin/employee-shares/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ visibleSections: editSections }),
      });
      toast({ title: "Sections updated", description: "The next view will reflect the new visibility." });
      setEditing(null);
      await refresh();
    } catch (e) {
      toast({ title: "Update failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingEdit(false);
    }
  }

  async function revoke(r: ShareLink) {
    if (!window.confirm(`Revoke link${r.recipientLabel ? ` for ${r.recipientLabel}` : ""}? Anyone with the URL will be locked out immediately.`)) return;
    setBusy(r.id);
    try {
      await api(`/admin/employee-shares/${r.id}/revoke`, { method: "POST", body: JSON.stringify({}) });
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
        <h1 className="text-xl brand-wordmark brand-navy">Officer profile share links</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-4 max-w-2xl">
        No-login links for sending an officer's branded profile summary to a client contact.
        Each link expires (default 30 days), can be revoked instantly, and tracks view count.
        Recipients see name, photo, license, experience and skills — no contact info, no SSN,
        no banking, no emergency contact. Mint a new link from the Personnel row dialog.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No share links yet.</div>
      ) : (
        <div className="border rounded-lg overflow-x-auto bg-white" tabIndex={0} role="region" aria-label="Employee share links table">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Officer</th>
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
                const officer = [r.officerFirstName, r.officerLastName].filter(Boolean).join(" ") || "—";
                return (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-3 py-2">
                      <span className={`inline-block text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm border ${s.tone}`}>
                        {s.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{officer}</div>
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
                          <Button size="sm" variant="outline" onClick={() => openEdit(r)}>
                            <Pencil className="w-3 h-3 mr-1" />Edit sections
                          </Button>
                        )}
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

      <Dialog open={!!editing} onOpenChange={(v) => { if (!savingEdit && !v) setEditing(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="brand-navy">Edit visible sections</DialogTitle>
            <DialogDescription>
              {editing?.recipientLabel
                ? `Update what ${editing.recipientLabel} can see.`
                : "Update what this recipient can see."}
              {" "}Changes take effect the next time the link is opened — the URL stays the same.
            </DialogDescription>
          </DialogHeader>

          <EmployeeShareSectionsField
            value={editSections}
            onChange={setEditSections}
            disabled={savingEdit}
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={savingEdit}>Cancel</Button>
            <Button onClick={saveEdit} disabled={savingEdit} className="bg-brand-navy text-white hover:opacity-90">
              {savingEdit ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" />Saving…</> : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
