import { useCallback, useEffect, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { ArrowLeft, MapPin, Pencil, Plus, Trash2, QrCode, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useFkOptions } from "@/lib/fk";
import { getTable } from "@/lib/tables";
import { RowFormDialog } from "@/components/RowFormDialog";

type Site = {
  id: string;
  name: string;
  clientId: string;
  address: string | null;
  notes: string | null;
  locationLat: string | null;
  locationLng: string | null;
  patrolIntervalMinutes: number | null;
};

type Checkpoint = {
  id: string;
  siteId: string;
  label: string;
  code: string;
  isActive: boolean;
  createdAt: string;
};

type ScanRow = {
  id: string;
  scannedAt: string;
  checkpointLabel: string | null;
  firstName: string | null;
  lastName: string | null;
};

function fmt(iso: string) {
  return new Date(iso).toLocaleString();
}

export function SiteDetailPage() {
  const [, params] = useRoute("/sites/:id");
  const [, navigate] = useLocation();
  const siteId = params?.id ?? "";
  const sitesDescriptor = getTable("sites");

  const [site, setSite] = useState<Site | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { options: clientOptions } = useFkOptions("clients");

  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [scansLoading, setScansLoading] = useState(false);

  const loadSite = useCallback(async () => {
    if (!siteId) return;
    setLoading(true);
    setError(null);
    try {
      const row = await api<Site>(`/admin/tables/sites/${siteId}`);
      setSite(row);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  const loadCheckpoints = useCallback(async () => {
    if (!siteId) return;
    try {
      const data = await api<{ checkpoints: Checkpoint[] }>(`/admin/sites/${siteId}/checkpoints`);
      setCheckpoints(data.checkpoints);
    } catch { /* keep empty */ }
  }, [siteId]);

  const loadScans = useCallback(async () => {
    if (!siteId) return;
    setScansLoading(true);
    try {
      const data = await api<{ scans: ScanRow[] }>(`/admin/patrol/scans?siteId=${siteId}&limit=50`);
      setScans(data.scans);
    } catch { setScans([]); } finally { setScansLoading(false); }
  }, [siteId]);

  useEffect(() => { loadSite(); loadCheckpoints(); loadScans(); }, [loadSite, loadCheckpoints, loadScans]);

  async function createCheckpoint() {
    const label = newLabel.trim();
    if (!label) return;
    setCreating(true);
    try {
      await api(`/admin/sites/${siteId}/checkpoints`, {
        method: "POST",
        body: JSON.stringify({ label }),
      });
      setNewLabel("");
      await loadCheckpoints();
    } catch (e) {
      alert((e as Error).message);
    } finally { setCreating(false); }
  }

  async function toggleActive(c: Checkpoint) {
    try {
      await api(`/admin/checkpoints/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !c.isActive }),
      });
      await loadCheckpoints();
    } catch (e) { alert((e as Error).message); }
  }

  async function deleteCheckpoint(c: Checkpoint) {
    if (!confirm(`Delete checkpoint "${c.label}"? Existing scan history will be kept.`)) return;
    try {
      await api(`/admin/checkpoints/${c.id}`, { method: "DELETE" });
      await loadCheckpoints();
    } catch (e) { alert((e as Error).message); }
  }

  if (!sitesDescriptor) return null;

  const clientName = site ? clientOptions.find((o) => o.id === site.clientId)?.label ?? "—" : "";

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="px-6 py-4 border-b bg-card">
        <Link href="/tables/sites" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground mb-2">
          <ArrowLeft className="w-3.5 h-3.5 mr-1" />
          Back to all sites
        </Link>
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading site…</div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : !site ? (
          <div className="text-sm text-muted-foreground">Site not found.</div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl brand-navy" style={{ fontFamily: "Georgia, serif", fontWeight: 700 }}>
                {site.name}
              </h1>
              <div className="mt-1 text-sm text-muted-foreground">
                Client: <span className="text-foreground font-medium">{clientName}</span>
              </div>
              {site.address && (
                <div className="mt-1 text-sm text-muted-foreground inline-flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />{site.address}
                </div>
              )}
              {site.locationLat != null && site.locationLng != null ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  Coordinates: <span className="text-foreground font-medium">{site.locationLat}, {site.locationLng}</span>
                </div>
              ) : (
                <div className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-800 bg-amber-100 border border-amber-300 rounded px-2 py-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Needs coordinates — click <span className="underline">Edit site</span> and Geocode the address so this site is usable by the live map and the clock-in picker.
                </div>
              )}
              {site.patrolIntervalMinutes != null && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Patrol interval: <span className="text-foreground font-medium">{site.patrolIntervalMinutes}m</span>
                </div>
              )}
              {site.notes && (
                <div className="mt-2 text-sm whitespace-pre-wrap text-muted-foreground max-w-3xl">
                  {site.notes}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="w-3.5 h-3.5 mr-1" />Edit site
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate("/tables/sites")}>
                All sites
              </Button>
            </div>
          </div>
        )}
      </div>

      {site && (
        <div className="p-6 space-y-8">
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold inline-flex items-center gap-2">
                <QrCode className="w-4 h-4" /> Patrol checkpoints
              </h2>
              <div className="text-xs text-muted-foreground">
                Print each code as a QR or NFC tag. Officers scan it to log a patrol.
              </div>
            </div>

            <div className="flex gap-2 mb-3">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Checkpoint label (e.g. Main Entrance)"
                className="flex-1 border rounded px-3 py-2 text-sm bg-background"
                disabled={creating}
              />
              <Button size="sm" onClick={createCheckpoint} disabled={creating || !newLabel.trim()}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Add
              </Button>
            </div>

            {checkpoints.length === 0 ? (
              <div className="text-sm text-muted-foreground border rounded p-4">
                No checkpoints yet. Add one above to start logging patrol scans.
              </div>
            ) : (
              <div className="border rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Label</th>
                      <th className="text-left px-3 py-2 font-medium">Code</th>
                      <th className="text-left px-3 py-2 font-medium">Status</th>
                      <th className="text-right px-3 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checkpoints.map((c) => (
                      <tr key={c.id} className="border-t">
                        <td className="px-3 py-2">{c.label}</td>
                        <td className="px-3 py-2 font-mono text-xs">{c.code}</td>
                        <td className="px-3 py-2">
                          <span className={c.isActive ? "text-emerald-600" : "text-muted-foreground"}>
                            {c.isActive ? "Active" : "Disabled"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button variant="ghost" size="sm" onClick={() => toggleActive(c)}>
                            {c.isActive ? "Disable" : "Enable"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => deleteCheckpoint(c)}>
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Recent scans</h2>
              <Button variant="outline" size="sm" onClick={loadScans} disabled={scansLoading}>
                Refresh
              </Button>
            </div>
            {scansLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : scans.length === 0 ? (
              <div className="text-sm text-muted-foreground border rounded p-4">
                No scans recorded at this site yet.
              </div>
            ) : (
              <div className="border rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">When</th>
                      <th className="text-left px-3 py-2 font-medium">Officer</th>
                      <th className="text-left px-3 py-2 font-medium">Checkpoint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map((s) => (
                      <tr key={s.id} className="border-t">
                        <td className="px-3 py-2 text-muted-foreground">{fmt(s.scannedAt)}</td>
                        <td className="px-3 py-2">{[s.firstName, s.lastName].filter(Boolean).join(" ") || "—"}</td>
                        <td className="px-3 py-2">{s.checkpointLabel ?? <span className="text-muted-foreground">(removed)</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {site && (
        <RowFormDialog
          open={editing}
          onOpenChange={setEditing}
          descriptor={sitesDescriptor}
          initial={site as unknown as Record<string, unknown>}
          onSaved={() => { setEditing(false); loadSite(); }}
        />
      )}
    </div>
  );
}
