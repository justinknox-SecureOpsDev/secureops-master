import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { ArrowLeft, MapPin, Pencil, Plus, Trash2, QrCode, AlertTriangle, Radius } from "lucide-react";
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
  geofenceRadiusMiles: string | null;
  effectiveGeofenceRadiusMiles?: number;
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

// Canonical geofence radius clamp range, shared by the build-time preview,
// the in-iframe drag handle, and the parent's PATCH-time guard so all three
// agree on the same min/max. Mirrors the spirit of the backend's float
// validation: too-tight a radius creates false-breach pages (we already
// surface a "tighter than typical GPS accuracy" warning at 0.05 mi), and
// too-wide a radius silently disables breach alerts altogether.
const GEOFENCE_MIN_MILES = 0.01;
const GEOFENCE_MAX_MILES = 30;
const METERS_PER_MILE = 1609.344;
const GEOFENCE_MIN_METERS = GEOFENCE_MIN_MILES * METERS_PER_MILE; // ~16 m
const GEOFENCE_MAX_METERS = GEOFENCE_MAX_MILES * METERS_PER_MILE; // ~48,280 m

/**
 * Build the srcDoc for the embedded geofence preview map.
 *
 * Mirrors the styling of `buildLeafletHtml` in Dispatch.tsx: navy/gold
 * theme, square "S" site pin, translucent gold disc sized to the effective
 * geofence radius. Single site + circle only — no officer/incident pins.
 *
 * Interactive: the site pin is draggable (moves lat/lng) and a small gold
 * edge handle on the east side resizes the radius. Each drag-end posts a
 * `wcsg:geofence-change` message to the parent window, which PATCHes the
 * site back to the API. The parent clamps the radius before saving so a
 * runaway tiny drag can't permanently disable breach alerts.
 *
 * Inputs (lat/lng/radiusMiles) are validated numbers controlled by us;
 * label is JSON-encoded and rendered DOM-side via createTextNode so a
 * malicious site name can't break out of the script context.
 */
function buildSiteGeofenceHtml(
  lat: number,
  lng: number,
  radiusMiles: number,
  label: string,
): string {
  const safeLabel = JSON.stringify(label)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const radiusMeters = Math.max(GEOFENCE_MIN_METERS, Math.min(radiusMiles * METERS_PER_MILE, GEOFENCE_MAX_METERS));
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;padding:0;height:100%;background:#080c18}
.site-pin{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:#080c18;color:#c9a84c;border:2px solid #c9a84c;font:bold 13px -apple-system,system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:move}
.edge-handle{width:14px;height:14px;border-radius:50%;background:#c9a84c;border:2px solid #080c18;box-shadow:0 1px 3px rgba(0,0,0,.55);cursor:ew-resize}
.readout{position:absolute;left:8px;bottom:8px;z-index:500;background:rgba(8,12,24,.85);color:#f0e6c8;font:600 11px -apple-system,system-ui,sans-serif;padding:4px 8px;border:1px solid #c9a84c;border-radius:4px;pointer-events:none}
.readout.saving{color:#c9a84c}
.readout.error{color:#fca5a5;border-color:#fca5a5}</style>
</head><body><div id="m"></div><div id="r" class="readout"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const LAT = ${lat};
const LNG = ${lng};
const R_M = ${radiusMeters};
const LABEL = ${safeLabel};
const MIN_R_M = ${GEOFENCE_MIN_METERS}; // shared with parent / build-time clamp
const MAX_R_M = ${GEOFENCE_MAX_METERS};
const map = L.map('m', { zoomControl: true, attributionControl: true });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap', maxZoom: 19
}).addTo(map);
let center = L.latLng(LAT, LNG);
let radiusM = R_M;
const circle = L.circle(center, {
  radius: radiusM,
  color: '#c9a84c',
  weight: 1,
  opacity: 0.45,
  fillColor: '#c9a84c',
  fillOpacity: 0.08,
  interactive: false,
}).addTo(map);
const siteIcon = L.divIcon({
  className: '', html: '<div class="site-pin">S</div>',
  iconSize: [28, 28], iconAnchor: [14, 14]
});
const handleIcon = L.divIcon({
  className: '', html: '<div class="edge-handle"></div>',
  iconSize: [14, 14], iconAnchor: [7, 7]
});
const tipEl = document.createElement('div');
const b = document.createElement('b');
b.appendChild(document.createTextNode(String(LABEL || '')));
tipEl.appendChild(b);
const siteMarker = L.marker(center, { icon: siteIcon, draggable: true, autoPan: true }).addTo(map);
siteMarker.bindTooltip(tipEl, { direction: 'top', offset: [0, -6], opacity: 0.95 });
function eastEdge(c, rm) {
  const cosLat = Math.cos(c.lat * Math.PI / 180);
  const dLng = rm / (111320 * Math.max(0.01, cosLat));
  return L.latLng(c.lat, c.lng + dLng);
}
const handle = L.marker(eastEdge(center, radiusM), { icon: handleIcon, draggable: true, autoPan: true }).addTo(map);
const readout = document.getElementById('r');
function paintReadout(state) {
  readout.className = 'readout' + (state ? ' ' + state : '');
  const miles = radiusM / 1609.344;
  const ft = Math.round(miles * 5280);
  const prefix = state === 'saving' ? 'Saving… ' : state === 'error' ? 'Save failed — ' : '';
  readout.textContent = prefix + 'Radius ' + miles.toFixed(3) + ' mi (~' + ft.toLocaleString() + ' ft) · ' + center.lat.toFixed(5) + ', ' + center.lng.toFixed(5);
}
paintReadout('');
siteMarker.on('drag', (e) => {
  center = e.latlng;
  circle.setLatLng(center);
  handle.setLatLng(eastEdge(center, radiusM));
  paintReadout('');
});
siteMarker.on('dragend', () => post());
handle.on('drag', (e) => {
  const d = center.distanceTo(e.latlng);
  radiusM = Math.max(MIN_R_M, Math.min(d, MAX_R_M));
  circle.setRadius(radiusM);
  // snap handle visually to the actual east edge so it stays on the perimeter
  handle.setLatLng(eastEdge(center, radiusM));
  paintReadout('');
});
handle.on('dragend', () => post());
function post() {
  paintReadout('saving');
  parent.postMessage({
    type: 'wcsg:geofence-change',
    lat: center.lat,
    lng: center.lng,
    radiusMiles: Number((radiusM / 1609.344).toFixed(4)),
  }, '*');
}
window.addEventListener('message', (ev) => {
  const d = ev && ev.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'wcsg:geofence-saved') paintReadout('');
  else if (d.type === 'wcsg:geofence-save-failed') paintReadout('error');
});
map.fitBounds(circle.getBounds().pad(0.3), { maxZoom: 17 });
</script></body></html>`;
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
  const [globalGeofenceRadiusMiles, setGlobalGeofenceRadiusMiles] = useState<number | null>(null);
  // Snapshot of the initial map state so the iframe srcDoc is built exactly
  // once per site (any later in-place lat/lng/radius updates come from the
  // map's own drag handlers, not React). This keeps the iframe from reloading
  // out from under the user mid-drag.
  const initialMapRef = useRef<{ lat: number; lng: number; r: number; name: string } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Bumped on save failure to force the iframe to fully remount, guaranteeing
  // the map visually rolls back to server-truth geometry even when the
  // freshly computed srcDoc string happens to be byte-identical.
  const [iframeVersion, setIframeVersion] = useState(0);

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await api<{ geofenceRadiusMiles?: number }>("/dispatch/config");
        const n = body.geofenceRadiusMiles;
        if (!cancelled && typeof n === "number" && isFinite(n) && n > 0) {
          setGlobalGeofenceRadiusMiles(n);
        }
      } catch { /* keep null, UI will fall back to default copy */ }
    })();
    return () => { cancelled = true; };
  }, []);

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

  // Reset the cached initial map snapshot when navigating to a different site.
  useEffect(() => {
    initialMapRef.current = null;
  }, [siteId]);

  // Build the geofence preview HTML from the effective radius the badge above
  // displays. We snapshot the first valid (lat,lng,r) we see for this site into
  // a ref so the srcDoc string stays stable across re-renders — the iframe's
  // own drag handlers own the live state from that point forward, and we only
  // re-key it when the underlying coords change via the Edit dialog.
  // Hooks must run unconditionally — must stay above any early return below.
  const geofenceMapHtml = useMemo(() => {
    if (!site) return null;
    const lat = site.locationLat != null ? Number(site.locationLat) : NaN;
    const lng = site.locationLng != null ? Number(site.locationLng) : NaN;
    if (!isFinite(lat) || !isFinite(lng)) return null;
    const overrideNum = site.geofenceRadiusMiles != null ? Number(site.geofenceRadiusMiles) : NaN;
    const hasOverride = Number.isFinite(overrideNum) && overrideNum > 0;
    const globalR = globalGeofenceRadiusMiles ?? 0.25;
    const effective = site.effectiveGeofenceRadiusMiles ?? (hasOverride ? overrideNum : globalR);
    if (!initialMapRef.current) {
      initialMapRef.current = { lat, lng, r: effective, name: site.name };
    }
    const s = initialMapRef.current;
    return buildSiteGeofenceHtml(s.lat, s.lng, s.r, s.name);
  }, [site, globalGeofenceRadiusMiles]);

  // Save drag-end events from the iframe map back to the server. Clamp the
  // radius defensively here too: the iframe already clamps to [16 m, 50 km]
  // but a buggy or replayed message shouldn't be trusted blindly.
  //
  // Concurrency model: only one PATCH may be in flight at a time, but if the
  // user releases another drag while a save is pending we stash the latest
  // intent in `pendingRef` and fire it as soon as the in-flight save settles.
  // This guarantees the final dragged position/radius always reaches the
  // backend, while collapsing rapid-fire drag releases into the most recent.
  const savingRef = useRef(false);
  const pendingRef = useRef<{ lat: number; lng: number; r: number } | null>(null);
  useEffect(() => {
    // Capture siteId at effect-mount so async responses that resolve after
    // the user has navigated to a different site can't bleed into the new
    // page's state. The iframe element itself is resolved at send-time from
    // iframeRef — capturing it at mount would be `null` on the very first
    // render (site is still loading) and ACK messages would never reach the
    // map's readout.
    const ownSiteId = siteId;
    let cancelled = false;
    type Pending = { lat: number; lng: number; r: number };
    async function flush(next: Pending) {
      const reply = (type: "wcsg:geofence-saved" | "wcsg:geofence-save-failed") => {
        if (cancelled) return;
        iframeRef.current?.contentWindow?.postMessage({ type }, "*");
      };
      const replyOk = () => reply("wcsg:geofence-saved");
      const replyErr = () => reply("wcsg:geofence-save-failed");
      savingRef.current = true;
      try {
        const updated = await api<Site>(`/admin/tables/sites/${ownSiteId}`, {
          method: "PATCH",
          body: JSON.stringify({
            locationLat: String(next.lat),
            locationLng: String(next.lng),
            geofenceRadiusMiles: String(next.r),
          }),
        });
        if (cancelled) return;
        // Optimistically merge the saved values into local state for the
        // text badge above. The iframe srcDoc memo is gated by initialMapRef
        // so this won't tear down the running map.
        setSite((prev) => (prev && prev.id === ownSiteId ? { ...prev, ...updated } : prev));
        replyOk();
      } catch (e) {
        if (cancelled) return;
        replyErr();
        alert(`Couldn't save geofence change: ${(e as Error).message}`);
        // Reset the snapshot, drop queued saves, and force the iframe to
        // remount via a version bump — otherwise the iframe would keep
        // showing the unsaved dragged circle (React may skip updating srcDoc
        // when the new string is byte-identical to the prior one).
        initialMapRef.current = null;
        pendingRef.current = null;
        setIframeVersion((v) => v + 1);
        loadSite();
      } finally {
        savingRef.current = false;
        const queued = pendingRef.current;
        if (queued && !cancelled) {
          pendingRef.current = null;
          // Fire-and-forget; this call sets savingRef again before awaiting.
          void flush(queued);
        }
      }
    }
    function onMsg(ev: MessageEvent) {
      // Only accept messages from our own iframe — ignore postMessage chatter
      // from extensions, parent frames, or unrelated windows.
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const d = ev.data as { type?: string; lat?: number; lng?: number; radiusMiles?: number } | null;
      if (!d || typeof d !== "object" || d.type !== "wcsg:geofence-change") return;
      if (typeof d.lat !== "number" || !isFinite(d.lat) || d.lat < -90 || d.lat > 90) return;
      if (typeof d.lng !== "number" || !isFinite(d.lng) || d.lng < -180 || d.lng > 180) return;
      if (typeof d.radiusMiles !== "number" || !isFinite(d.radiusMiles)) return;
      const next: Pending = {
        lat: d.lat,
        lng: d.lng,
        r: Math.max(GEOFENCE_MIN_MILES, Math.min(d.radiusMiles, GEOFENCE_MAX_MILES)),
      };
      if (savingRef.current) {
        // Collapse rapid drag-releases: only the latest pending state matters.
        pendingRef.current = next;
        return;
      }
      void flush(next);
    }
    window.addEventListener("message", onMsg);
    return () => {
      // Mark this effect's flush callbacks stale before unmounting the
      // listener so any in-flight save that resolves after navigation can't
      // call setSite/loadSite/postMessage against the next site's state.
      cancelled = true;
      window.removeEventListener("message", onMsg);
    };
  }, [siteId, loadSite]);

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
              <div className="mt-1 text-xs text-muted-foreground inline-flex items-center gap-1 flex-wrap">
                <Radius className="w-3.5 h-3.5" />
                Geofence radius:{" "}
                {(() => {
                  const overrideRaw = site.geofenceRadiusMiles;
                  const overrideNum = overrideRaw != null ? Number(overrideRaw) : NaN;
                  const hasOverride = Number.isFinite(overrideNum) && overrideNum > 0;
                  const globalR = globalGeofenceRadiusMiles ?? 0.25;
                  const effective = site.effectiveGeofenceRadiusMiles
                    ?? (hasOverride ? overrideNum : globalR);
                  const feet = Math.round(effective * 5280);
                  const tooTight = hasOverride && overrideNum < 0.05;
                  return (
                    <>
                      <span className="text-foreground font-medium">
                        {hasOverride ? "Override: " : "Default: "}
                        {effective} mi (≈ {feet.toLocaleString()} ft)
                      </span>
                      <span className="ml-1">
                        {hasOverride
                          ? <>— per-site override (global default is {globalR} mi). Clear in <span className="underline">Edit site</span> to use the default.</>
                          : <>— inherits the global default (set via <code className="font-mono">GEOFENCE_RADIUS_MILES</code>). Set a per-site value in <span className="underline">Edit site</span> to override.</>}
                        {site.locationLat == null || site.locationLng == null ? " Add coordinates above to enable breach alerts here." : ""}
                      </span>
                      {tooTight && (
                        <span
                          role="status"
                          className="basis-full mt-1 inline-flex items-start gap-1 text-xs font-semibold text-amber-800 bg-amber-100 border border-amber-300 rounded px-2 py-1"
                        >
                          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                          <span>
                            Tighter than typical phone GPS accuracy (~30–65 ft). Expect frequent false-breach pages to admins; recommend ≥ 0.1 mi (~528 ft).
                          </span>
                        </span>
                      )}
                    </>
                  );
                })()}
              </div>
              {geofenceMapHtml && (
                <div className="mt-3 max-w-3xl">
                  <div className="rounded border overflow-hidden" style={{ height: 240 }}>
                    <iframe
                      key={`geofence-${siteId}-${iframeVersion}`}
                      ref={iframeRef}
                      title={`${site.name} geofence preview`}
                      srcDoc={geofenceMapHtml}
                      sandbox="allow-scripts"
                      referrerPolicy="no-referrer"
                      style={{ width: "100%", height: "100%", border: 0, display: "block" }}
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Drag the <strong>S</strong> pin to nudge the site's coordinates, or drag the small gold dot on the edge to resize the geofence. Changes save automatically.
                  </div>
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
          onSaved={() => {
            setEditing(false);
            // Reset the snapshot so a manual coord/radius edit in the dialog
            // takes effect in the iframe map on the next render.
            initialMapRef.current = null;
            loadSite();
          }}
        />
      )}
    </div>
  );
}
