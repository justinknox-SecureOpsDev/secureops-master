import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Link, useRoute, useLocation } from "wouter";
import { ArrowLeft, MapPin, Pencil, Plus, Trash2, QrCode, AlertTriangle, Radius, RefreshCw, Printer, Loader2, CalendarPlus, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, fetchWithAuth } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useFkOptions } from "@/lib/fk";
import { getTable } from "@/lib/tables";
import { RowFormDialog } from "@/components/RowFormDialog";
import { ShiftDialog } from "@/components/ShiftDialog";
import { RepeatingShiftDialog } from "@/components/RepeatingShiftDialog";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ResponsiveTable";

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

type TimeEntryRow = {
  id: string;
  employeeName: string | null;
  clockInTime: string | null;
  clockOutTime: string | null;
  hoursWorked: string | null;
  approvalStatus: string | null;
  correctionRequested?: boolean | null;
  correctionNote?: string | null;
};

type SubEntryRow = {
  id: string;
  name: string;
  company: string;
  badgeId: string | null;
  clockInAt: string | null;
  clockOutAt: string | null;
  hoursWorked: string | null;
};

function fmt(iso: string) {
  return new Date(iso).toLocaleString();
}

// ISO timestamp -> value for a <input type="datetime-local"> in LOCAL time
// (YYYY-MM-DDTHH:mm). Returns "" for null/invalid so the input stays empty.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Local YYYY-MM-DD for date inputs (avoids UTC off-by-one from toISOString).
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
// Random value re-evaluated on every HMR reload of this module. Included in
// the iframe-srcdoc useMemo deps so that dev-time edits to the map template
// actually take effect without a hard refresh of the browser tab.
const MAP_BUILD_ID = Math.random().toString(36).slice(2, 10);

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
// Leaflet requires a view (center + zoom) BEFORE any layer that needs
// projection (L.circle uses a metric radius and projects on add). Without
// this, adding a circle throws "Cannot read properties of undefined
// (reading 'layerPointToLatLng')" / "Set map center and zoom first".
map.setView([LAT, LNG], 16);
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
siteMarker.getElement()?.setAttribute('aria-label', 'Site location — drag to reposition');
siteMarker.bindTooltip(tipEl, { direction: 'top', offset: [0, -6], opacity: 0.95 });
function eastEdge(c, rm) {
  const cosLat = Math.cos(c.lat * Math.PI / 180);
  const dLng = rm / (111320 * Math.max(0.01, cosLat));
  return L.latLng(c.lat, c.lng + dLng);
}
const handle = L.marker(eastEdge(center, radiusM), { icon: handleIcon, draggable: true, autoPan: true }).addTo(map);
handle.getElement()?.setAttribute('aria-label', 'Geofence radius — drag to resize');
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
// Compute fit bounds manually instead of circle.getBounds(). The Leaflet
// 1.9.4 Circle.getBounds() path (Circle.js:62) reads this._map.layerPointToLatLng
// and has hit "Cannot read properties of undefined" in this sandboxed iframe
// even after the circle is .addTo(map)'d. Manual lat/lng box is bulletproof.
const _cosLat = Math.cos(center.lat * Math.PI / 180);
const _dLat = radiusM / 111320;
const _dLng = radiusM / (111320 * Math.max(0.01, _cosLat));
map.fitBounds(L.latLngBounds(
  [center.lat - _dLat, center.lng - _dLng],
  [center.lat + _dLat, center.lng + _dLng],
).pad(0.3), { maxZoom: 17 });
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

  // Time-entries reference list (read-only). Defaults to the last 30 days.
  const [timeEntries, setTimeEntries] = useState<TimeEntryRow[]>([]);
  const [teLoading, setTeLoading] = useState(false);
  const [teError, setTeError] = useState<string | null>(null);
  const [teFrom, setTeFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return ymd(d);
  });
  const [teTo, setTeTo] = useState<string>(() => ymd(new Date()));
  const [teExporting, setTeExporting] = useState(false);
  // Inline approve/reject: which row is mid-action, per-row hours overrides
  // (mirrors the mobile time-approval screen), and any action error.
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Single-shift create mirrors the server gate (POST /shifts = admin OR lead);
  // repeating series is admin-only (POST /shifts/repeat = requireAdmin → isAdmin).
  const canCreateShift = user?.role === "admin" || user?.role === "lead";
  const [teActioningId, setTeActioningId] = useState<string | null>(null);
  const [teHoursEdits, setTeHoursEdits] = useState<Record<string, string>>({});
  const [teActionError, setTeActionError] = useState<string | null>(null);
  // Inline timestamp correction: which row's clock-in/out times are being
  // edited, the draft datetime-local values, and whether a save is in flight.
  const [teTimeEditingId, setTeTimeEditingId] = useState<string | null>(null);
  const [teTimeDraft, setTeTimeDraft] = useState<{ clockIn: string; clockOut: string }>({ clockIn: "", clockOut: "" });
  const [teTimeSaving, setTeTimeSaving] = useState(false);

  // Subcontractor (QR-based) time entries for this site. Reuses the same
  // From/To date range as the officer time-entries list above.
  const [subEntries, setSubEntries] = useState<SubEntryRow[]>([]);
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
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

  // Shift creation launched from this site's page — the dialogs are prefilled to
  // the current site so an admin can post coverage without bouncing to the
  // standalone Shifts page. shiftMsg is a transient post-create confirmation.
  const [creatingShift, setCreatingShift] = useState(false);
  const [repeatingShift, setRepeatingShift] = useState(false);
  const [shiftMsg, setShiftMsg] = useState<string | null>(null);
  // Stable `initial` for the single-shift create dialog. ShiftDialog resets its
  // form whenever `open` or `initial` changes, so this must be memoised on the
  // (stable) route siteId — an inline object would reset the form every render.
  // Declared here with the other hooks so it stays above all early returns.
  const shiftCreateInitial = useMemo(() => ({ siteId }), [siteId]);

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

  const loadTimeEntries = useCallback(async () => {
    if (!siteId) return;
    setTeLoading(true);
    setTeError(null);
    try {
      const qs = new URLSearchParams({ siteId });
      if (teFrom) qs.set("from", `${teFrom}T00:00:00.000Z`);
      // Inclusive of the whole "to" day so a same-day filter isn't empty.
      if (teTo) qs.set("to", `${teTo}T23:59:59.999Z`);
      const rows = await api<TimeEntryRow[]>(`/time-entries?${qs.toString()}`);
      // Newest first for a reference list.
      rows.sort((a, b) => (b.clockInTime ?? "").localeCompare(a.clockInTime ?? ""));
      setTimeEntries(rows);
    } catch (e) {
      setTeError((e as Error).message);
      setTimeEntries([]);
    } finally {
      setTeLoading(false);
    }
  }, [siteId, teFrom, teTo]);

  // Roll-up summary for the time-entries list, recomputed whenever the rows
  // change. The From/To filter reloads `timeEntries`, so this tracks the range.
  const timeEntriesSummary = useMemo(() => {
    let totalHours = 0;
    let approvedHours = 0;
    let pendingCount = 0;
    let approvedCount = 0;
    let rejectedCount = 0;
    const officers = new Set<string>();
    for (const t of timeEntries) {
      const h = t.hoursWorked != null ? Number(t.hoursWorked) : 0;
      const hours = Number.isFinite(h) ? h : 0;
      totalHours += hours;
      const officer = t.employeeName?.trim();
      if (officer) officers.add(officer);
      if (t.approvalStatus === "approved") {
        approvedCount += 1;
        approvedHours += hours;
      } else if (t.approvalStatus === "rejected") {
        rejectedCount += 1;
      } else {
        pendingCount += 1;
      }
    }
    return {
      count: timeEntries.length,
      headcount: officers.size,
      totalHours,
      approvedHours,
      pendingCount,
      approvedCount,
      rejectedCount,
    };
  }, [timeEntries]);

  async function exportTimeEntriesCsv() {
    if (!siteId) return;
    setTeExporting(true);
    setTeError(null);
    try {
      const filters: Record<string, string> = { siteId };
      if (teFrom) filters.from = teFrom;
      if (teTo) filters.to = teTo;
      const res = await fetchWithAuth(`/api/admin/exports/csv`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: "time_entries", filters }),
      });
      if (!res.ok) {
        let msg = `Export failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
          else if (j?.error) msg = j.error;
        } catch { /* not JSON */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const disp = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="?([^";]+)"?/.exec(disp);
      const filename = m?.[1] ?? `wcsg-time_entries-${new Date().toISOString().slice(0, 10)}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setTeError((e as Error).message);
    } finally {
      setTeExporting(false);
    }
  }

  // Admin-only: approve/reject a single time entry inline, reusing
  // POST /time-entries/:id/approve. On approve we may pass an edited
  // hours override (mirrors the mobile time-approval screen); on reject
  // we leave hours untouched. The list re-fetches so the new status shows.
  async function decideTimeEntry(t: TimeEntryRow, decision: "approved" | "rejected") {
    if (!t.clockOutTime) {
      setTeActionError("This entry is still in progress — wait until the officer clocks out before approving or rejecting it.");
      return;
    }
    setTeActionError(null);
    setTeActioningId(t.id);
    try {
      const body: { decision: "approved" | "rejected"; hoursWorked?: number } = { decision };
      if (decision === "approved") {
        const raw = teHoursEdits[t.id];
        const hours = raw != null && raw !== "" ? parseFloat(raw) : (t.hoursWorked != null ? parseFloat(t.hoursWorked) : NaN);
        if (!Number.isFinite(hours) || hours <= 0) {
          setTeActionError("Enter a positive number of hours before approving.");
          setTeActioningId(null);
          return;
        }
        body.hoursWorked = hours;
      }
      await api(`/time-entries/${t.id}/approve`, { method: "POST", body });
      setTeHoursEdits((e) => { const n = { ...e }; delete n[t.id]; return n; });
      await loadTimeEntries();
    } catch (e) {
      setTeActionError((e as Error).message);
    } finally {
      setTeActioningId(null);
    }
  }

  // Open the inline timestamp editor for a row, prefilling the draft from the
  // entry's current clock-in / clock-out times (in the admin's local zone).
  function startEditTimes(t: TimeEntryRow) {
    setTeActionError(null);
    setTeTimeEditingId(t.id);
    setTeTimeDraft({ clockIn: toLocalInput(t.clockInTime), clockOut: toLocalInput(t.clockOutTime) });
  }

  function cancelEditTimes() {
    setTeTimeEditingId(null);
    setTeTimeDraft({ clockIn: "", clockOut: "" });
  }

  // Admin-only: correct a time entry's clock-in / clock-out timestamps inline
  // via PATCH /time-entries/:id/times. The server recomputes hours, stamps
  // last-edited provenance, and re-syncs the invoice if the entry is approved.
  async function saveEditTimes(t: TimeEntryRow) {
    const { clockIn, clockOut } = teTimeDraft;
    if (!clockIn) {
      setTeActionError("Enter a clock-in time.");
      return;
    }
    const clockInIso = new Date(clockIn).toISOString();
    const clockOutIso = clockOut ? new Date(clockOut).toISOString() : null;
    if (clockOutIso && new Date(clockOutIso).getTime() <= new Date(clockInIso).getTime()) {
      setTeActionError("Clock-out must be after clock-in.");
      return;
    }
    setTeActionError(null);
    setTeTimeSaving(true);
    try {
      const body: { clockInTime: string; clockOutTime?: string } = { clockInTime: clockInIso };
      if (clockOutIso) body.clockOutTime = clockOutIso;
      await api(`/time-entries/${t.id}/times`, { method: "PATCH", body });
      cancelEditTimes();
      await loadTimeEntries();
    } catch (e) {
      setTeActionError((e as Error).message);
    } finally {
      setTeTimeSaving(false);
    }
  }

  // Admin-only: dismiss an officer's correction request without editing the
  // timestamps (e.g. it was already handled or a misunderstanding). Clears the
  // amber "Correction" badge via POST /time-entries/:id/dismiss-correction.
  async function dismissCorrection(t: TimeEntryRow) {
    setTeActionError(null);
    setTeActioningId(t.id);
    try {
      await api(`/time-entries/${t.id}/dismiss-correction`, { method: "POST" });
      await loadTimeEntries();
    } catch (e) {
      setTeActionError((e as Error).message);
    } finally {
      setTeActioningId(null);
    }
  }

  const loadSubEntries = useCallback(async () => {
    if (!siteId) return;
    setSubLoading(true);
    setSubError(null);
    try {
      const qs = new URLSearchParams({ siteId });
      if (teFrom) qs.set("dateFrom", `${teFrom}T00:00:00.000Z`);
      if (teTo) qs.set("dateTo", `${teTo}T23:59:59.999Z`);
      const rows = await api<SubEntryRow[]>(`/admin/subcontractor-entries?${qs.toString()}`);
      rows.sort((a, b) => (b.clockInAt ?? "").localeCompare(a.clockInAt ?? ""));
      setSubEntries(rows);
    } catch (e) {
      setSubError((e as Error).message);
      setSubEntries([]);
    } finally {
      setSubLoading(false);
    }
  }, [siteId, teFrom, teTo]);

  function exportSubEntriesCsv() {
    const headers = ["ID", "Name", "Company", "Badge ID", "Clock In", "Clock Out", "Hours"];
    const rows = subEntries.map((e) => [
      e.id, e.name, e.company, e.badgeId ?? "",
      e.clockInAt ?? "", e.clockOutAt ?? "", e.hoursWorked ?? "",
    ]);
    // Quote every field; prefix leading =,+,-,@ with a single quote to defuse
    // spreadsheet formula injection (mirrors the server-side CSV export).
    const safe = (v: string) => {
      const s = /^[=+\-@]/.test(v) ? `'${v}` : v;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [headers, ...rows].map((r) => r.map((v) => safe(String(v))).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wcsg-subcontractor-entries-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  useEffect(() => { loadSite(); loadCheckpoints(); loadScans(); }, [loadSite, loadCheckpoints, loadScans]);

  useEffect(() => { void loadTimeEntries(); }, [loadTimeEntries]);

  useEffect(() => { void loadSubEntries(); }, [loadSubEntries]);

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
    // MAP_BUILD_ID re-evaluates on every HMR reload of this module so dev-time
    // edits to buildSiteGeofenceHtml actually take effect without a hard refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, globalGeofenceRadiusMiles, MAP_BUILD_ID]);

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
          method: "PUT",
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
                      key={`geofence-${siteId}-${iframeVersion}-${MAP_BUILD_ID}`}
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
          <SiteRateCard siteId={site.id} />

          {canCreateShift && (
            <section>
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <h2 className="text-lg font-semibold inline-flex items-center gap-2">
                  <CalendarPlus className="w-4 h-4" /> Shifts
                </h2>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => { setShiftMsg(null); setCreatingShift(true); }}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> New shift
                  </Button>
                  {isAdmin && (
                    <Button size="sm" variant="outline" onClick={() => { setShiftMsg(null); setRepeatingShift(true); }}>
                      <Repeat className="w-3.5 h-3.5 mr-1" /> Repeating shifts
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-sm text-muted-foreground max-w-3xl">
                Post a one-off shift{isAdmin ? " or a recurring series" : ""} for{" "}
                <span className="font-medium text-foreground">{site.name}</span>. The site is
                prefilled, and pay/bill rates default to this site's rate card for the chosen
                license level — override any field per shift.
              </p>
              {shiftMsg && (
                <div className="mt-3 inline-flex items-center gap-2 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
                  <span>{shiftMsg}</span>
                  <Link href="/tables/shifts" className="underline font-medium">View all shifts</Link>
                </div>
              )}
            </section>
          )}

          <SubcontractorQrCard siteId={site.id} siteName={site.name} />

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
              <ResponsiveTable
                data={checkpoints}
                getRowKey={(c) => c.id}
                columns={[
                  {
                    id: "label",
                    header: "Label",
                    mobile: "title",
                    cell: (c) => c.label,
                  },
                  {
                    id: "code",
                    header: "Code",
                    cell: (c) => c.code,
                    tdClassName: "font-mono text-xs",
                    mobileValueClassName: "font-mono text-xs",
                  },
                  {
                    id: "status",
                    header: "Status",
                    mobile: "meta",
                    cell: (c) => (
                      <span className={c.isActive ? "text-emerald-600" : "text-muted-foreground"}>
                        {c.isActive ? "Active" : "Disabled"}
                      </span>
                    ),
                    mobileCell: (c) => (
                      <span className={c.isActive ? "text-emerald-600 text-sm" : "text-muted-foreground text-sm"}>
                        {c.isActive ? "Active" : "Disabled"}
                      </span>
                    ),
                  },
                  {
                    id: "actions",
                    header: "Actions",
                    align: "right",
                    mobile: "actions",
                    cell: (c) => (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => toggleActive(c)}>
                          {c.isActive ? "Disable" : "Enable"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => deleteCheckpoint(c)}>
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </Button>
                      </>
                    ),
                    mobileCell: (c) => (
                      <>
                        <Button variant="outline" size="sm" className="flex-1 min-w-[5rem]" onClick={() => toggleActive(c)}>
                          {c.isActive ? "Disable" : "Enable"}
                        </Button>
                        <Button variant="outline" size="sm" className="flex-1 min-w-[5rem]" onClick={() => deleteCheckpoint(c)}>
                          <Trash2 className="w-3.5 h-3.5 text-destructive mr-1" /> Delete
                        </Button>
                      </>
                    ),
                  },
                ]}
              />
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
              <ResponsiveTable
                data={scans}
                getRowKey={(s) => s.id}
                columns={[
                  {
                    id: "when",
                    header: "When",
                    mobile: "meta",
                    cell: (s) => fmt(s.scannedAt),
                    tdClassName: "text-muted-foreground",
                    mobileCell: (s) => (
                      <span className="text-sm text-muted-foreground text-right">{fmt(s.scannedAt)}</span>
                    ),
                  },
                  {
                    id: "officer",
                    header: "Officer",
                    mobile: "title",
                    cell: (s) => [s.firstName, s.lastName].filter(Boolean).join(" ") || "—",
                  },
                  {
                    id: "checkpoint",
                    header: "Checkpoint",
                    cell: (s) => s.checkpointLabel ?? <span className="text-muted-foreground">(removed)</span>,
                  },
                ]}
              />
            )}
          </section>

          <section>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <h2 className="text-lg font-semibold">Time entries</h2>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col text-xs text-muted-foreground">
                  From
                  <input
                    type="date"
                    value={teFrom}
                    max={teTo || undefined}
                    onChange={(e) => setTeFrom(e.target.value)}
                    className="mt-0.5 border rounded px-2 py-1.5 text-sm bg-background text-foreground"
                  />
                </label>
                <label className="flex flex-col text-xs text-muted-foreground">
                  To
                  <input
                    type="date"
                    value={teTo}
                    min={teFrom || undefined}
                    onChange={(e) => setTeTo(e.target.value)}
                    className="mt-0.5 border rounded px-2 py-1.5 text-sm bg-background text-foreground"
                  />
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportTimeEntriesCsv}
                  disabled={teExporting || teLoading}
                >
                  {teExporting ? (
                    <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Exporting…</>
                  ) : (
                    "Export CSV"
                  )}
                </Button>
              </div>
            </div>

            {teError && (
              <div className="text-sm text-destructive border border-destructive/40 rounded p-3 mb-3">
                {teError}
              </div>
            )}

            {teActionError && (
              <div className="text-sm text-destructive border border-destructive/40 rounded p-3 mb-3">
                {teActionError}
              </div>
            )}

            {teLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : timeEntries.length === 0 ? (
              <div className="text-sm text-muted-foreground border rounded p-4">
                No time entries for this site in the selected date range.
              </div>
            ) : (
              <ResponsiveTable
                data={timeEntries}
                getRowKey={(t) => t.id}
                rowClassName="align-top"
                cardActionsClassName="items-end"
                desktopHeader={
                  <div className="flex flex-wrap items-stretch gap-2 mb-3">
                    <div className="border rounded px-3 py-2 bg-muted/30">
                      <div className="text-xs text-muted-foreground">Total hours</div>
                      <div className="text-lg font-semibold tabular-nums">
                        {timeEntriesSummary.totalHours.toFixed(2)}
                      </div>
                    </div>
                    <div className="border rounded px-3 py-2 bg-muted/30">
                      <div className="text-xs text-muted-foreground">Entries</div>
                      <div className="text-lg font-semibold tabular-nums">
                        {timeEntriesSummary.count}
                      </div>
                    </div>
                    <div className="border rounded px-3 py-2 bg-muted/30">
                      <div className="text-xs text-muted-foreground">Officers</div>
                      <div className="text-lg font-semibold tabular-nums">
                        {timeEntriesSummary.headcount}
                      </div>
                    </div>
                    <div className="border rounded px-3 py-2 bg-muted/30">
                      <div className="text-xs text-muted-foreground">Approved</div>
                      <div className="text-lg font-semibold tabular-nums text-emerald-600">
                        {timeEntriesSummary.approvedCount}
                        <span className="text-xs font-normal text-muted-foreground ml-1">
                          ({timeEntriesSummary.approvedHours.toFixed(2)} hrs)
                        </span>
                      </div>
                    </div>
                    <div className="border rounded px-3 py-2 bg-muted/30">
                      <div className="text-xs text-muted-foreground">Pending</div>
                      <div className="text-lg font-semibold tabular-nums text-amber-600">
                        {timeEntriesSummary.pendingCount}
                      </div>
                    </div>
                    {timeEntriesSummary.rejectedCount > 0 && (
                      <div className="border rounded px-3 py-2 bg-muted/30">
                        <div className="text-xs text-muted-foreground">Rejected</div>
                        <div className="text-lg font-semibold tabular-nums text-destructive">
                          {timeEntriesSummary.rejectedCount}
                        </div>
                      </div>
                    )}
                  </div>
                }
                columns={[
                  {
                    id: "officer",
                    header: "Officer",
                    mobile: "title",
                    cell: (t) => t.employeeName?.trim() || "—",
                  },
                  {
                    id: "clockIn",
                    header: "Clock in",
                    tdClassName: "text-muted-foreground",
                    cell: (t) =>
                      teTimeEditingId === t.id ? (
                        <input
                          type="datetime-local"
                          aria-label={`Clock in for ${t.employeeName?.trim() || "officer"}`}
                          value={teTimeDraft.clockIn}
                          onChange={(e) => setTeTimeDraft((d) => ({ ...d, clockIn: e.target.value }))}
                          disabled={teTimeSaving}
                          className="border rounded px-2 py-1 text-sm bg-background text-foreground"
                        />
                      ) : t.clockInTime ? fmt(t.clockInTime) : "—",
                    mobileCell: (t) => (t.clockInTime ? fmt(t.clockInTime) : "—"),
                  },
                  {
                    id: "clockOut",
                    header: "Clock out",
                    tdClassName: "text-muted-foreground",
                    cell: (t) =>
                      teTimeEditingId === t.id ? (
                        <input
                          type="datetime-local"
                          aria-label={`Clock out for ${t.employeeName?.trim() || "officer"}`}
                          value={teTimeDraft.clockOut}
                          onChange={(e) => setTeTimeDraft((d) => ({ ...d, clockOut: e.target.value }))}
                          disabled={teTimeSaving}
                          className="border rounded px-2 py-1 text-sm bg-background text-foreground"
                        />
                      ) : t.clockOutTime ? fmt(t.clockOutTime) : <span className="text-amber-600">In progress</span>,
                    mobileCell: (t) =>
                      t.clockOutTime ? fmt(t.clockOutTime) : <span className="text-amber-600">In progress</span>,
                  },
                  {
                    id: "hours",
                    header: "Hours",
                    align: "right",
                    tdClassName: "tabular-nums",
                    mobileValueClassName: "tabular-nums",
                    cell: (t) => (t.hoursWorked != null ? Number(t.hoursWorked).toFixed(2) : "—"),
                  },
                  {
                    id: "status",
                    header: "Status",
                    mobile: "meta",
                    cell: (t) => (
                      <>
                        <span className={
                          t.approvalStatus === "approved" ? "text-emerald-600"
                          : t.approvalStatus === "rejected" ? "text-destructive"
                          : "text-amber-600"
                        }>
                          {t.approvalStatus
                            ? t.approvalStatus.charAt(0).toUpperCase() + t.approvalStatus.slice(1)
                            : "—"}
                        </span>
                        {t.correctionRequested && (
                          <span
                            className="ml-2 inline-flex items-center gap-1 text-xs text-amber-600"
                            title={t.correctionNote || "Officer requested a time correction."}
                          >
                            <AlertTriangle className="w-3 h-3" /> Correction
                          </span>
                        )}
                        {isAdmin && t.correctionRequested && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ml-1 h-6 px-2 text-xs"
                            onClick={() => dismissCorrection(t)}
                            disabled={teActioningId === t.id}
                          >
                            {teActioningId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Dismiss"}
                          </Button>
                        )}
                      </>
                    ),
                    mobileCell: (t) => (
                      <>
                        <span className={
                          t.approvalStatus === "approved" ? "text-emerald-600 text-sm"
                          : t.approvalStatus === "rejected" ? "text-destructive text-sm"
                          : "text-amber-600 text-sm"
                        }>
                          {t.approvalStatus
                            ? t.approvalStatus.charAt(0).toUpperCase() + t.approvalStatus.slice(1)
                            : "—"}
                        </span>
                        {t.correctionRequested && (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-amber-600"
                            title={t.correctionNote || "Officer requested a time correction."}
                          >
                            <AlertTriangle className="w-3 h-3" /> Correction
                          </span>
                        )}
                        {isAdmin && t.correctionRequested && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => dismissCorrection(t)}
                            disabled={teActioningId === t.id}
                          >
                            {teActioningId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Dismiss"}
                          </Button>
                        )}
                      </>
                    ),
                  },
                  ...(isAdmin
                    ? [{
                        id: "actions",
                        header: "Actions",
                        thClassName: "text-right",
                        mobile: "actions" as const,
                        cell: (t: TimeEntryRow) => {
                          const status = (t.approvalStatus ?? "pending").toLowerCase();
                          const isPending = status === "pending";
                          const clockedOut = !!t.clockOutTime;
                          const busy = teActioningId === t.id;
                          const canAct = isAdmin && isPending && clockedOut;
                          const editingTimes = teTimeEditingId === t.id;
                          return editingTimes ? (
                            <div className="flex items-center justify-end gap-2">
                              <Button size="sm" onClick={() => saveEditTimes(t)} disabled={teTimeSaving}>
                                {teTimeSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save times"}
                              </Button>
                              <Button variant="outline" size="sm" onClick={cancelEditTimes} disabled={teTimeSaving}>
                                Cancel
                              </Button>
                            </div>
                          ) : canAct ? (
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <input
                                type="number"
                                step="0.25"
                                min="0"
                                inputMode="decimal"
                                aria-label={`Approve hours for ${t.employeeName?.trim() || "officer"}`}
                                value={teHoursEdits[t.id] ?? (t.hoursWorked != null ? Number(t.hoursWorked).toFixed(2) : "")}
                                onChange={(e) => setTeHoursEdits((prev) => ({ ...prev, [t.id]: e.target.value }))}
                                disabled={busy}
                                className="w-20 border rounded px-2 py-1 text-sm text-right tabular-nums bg-background text-foreground"
                              />
                              <Button size="sm" onClick={() => decideTimeEntry(t, "approved")} disabled={busy}>
                                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Approve"}
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => decideTimeEntry(t, "rejected")} disabled={busy}>
                                Reject
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => startEditTimes(t)} disabled={busy}>
                                <Pencil className="w-3.5 h-3.5 mr-1" />Edit times
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                              <span>{!clockedOut ? "—" : status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "—"}</span>
                              <Button variant="ghost" size="sm" onClick={() => startEditTimes(t)}>
                                <Pencil className="w-3.5 h-3.5 mr-1" />Edit times
                              </Button>
                            </div>
                          );
                        },
                        mobileCell: (t: TimeEntryRow) => {
                          const status = (t.approvalStatus ?? "pending").toLowerCase();
                          const isPending = status === "pending";
                          const clockedOut = !!t.clockOutTime;
                          const busy = teActioningId === t.id;
                          const canAct = isAdmin && isPending && clockedOut;
                          if (!canAct) return null;
                          return (
                            <>
                              <label className="flex flex-col text-xs text-muted-foreground">
                                Hours
                                <input
                                  type="number"
                                  step="0.25"
                                  min="0"
                                  inputMode="decimal"
                                  aria-label={`Approve hours for ${t.employeeName?.trim() || "officer"}`}
                                  value={teHoursEdits[t.id] ?? (t.hoursWorked != null ? Number(t.hoursWorked).toFixed(2) : "")}
                                  onChange={(e) => setTeHoursEdits((prev) => ({ ...prev, [t.id]: e.target.value }))}
                                  disabled={busy}
                                  className="mt-0.5 w-24 border rounded px-2 py-1.5 text-sm text-right tabular-nums bg-background text-foreground"
                                />
                              </label>
                              <Button
                                size="sm"
                                className="flex-1 min-w-[5rem]"
                                onClick={() => decideTimeEntry(t, "approved")}
                                disabled={busy}
                              >
                                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Approve"}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="flex-1 min-w-[5rem]"
                                onClick={() => decideTimeEntry(t, "rejected")}
                                disabled={busy}
                              >
                                Reject
                              </Button>
                            </>
                          );
                        },
                      } as ResponsiveColumn<TimeEntryRow>]
                    : []),
                ]}
              />
            )}
          </section>

          <section>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <h2 className="text-lg font-semibold">Subcontractor time entries</h2>
              <Button
                variant="outline"
                size="sm"
                onClick={exportSubEntriesCsv}
                disabled={subLoading || subEntries.length === 0}
              >
                Export CSV
              </Button>
            </div>
            <div className="text-xs text-muted-foreground mb-3">
              QR clock-ins by subcontractors at this site. Honors the date range above. Manage these on the{" "}
              <Link href="/subcontractors/clock-in-entries" className="underline">
                Subcontractor clock-in entries
              </Link>{" "}
              page.
            </div>

            {subError && (
              <div className="text-sm text-destructive border border-destructive/40 rounded p-3 mb-3">
                {subError}
              </div>
            )}

            {subLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : subEntries.length === 0 ? (
              <div className="text-sm text-muted-foreground border rounded p-4">
                No subcontractor time entries for this site in the selected date range.
              </div>
            ) : (
              <ResponsiveTable
                data={subEntries}
                getRowKey={(s) => s.id}
                columns={[
                  {
                    id: "name",
                    header: "Name",
                    mobile: "title",
                    cell: (s) => s.name?.trim() || "—",
                  },
                  {
                    id: "company",
                    header: "Company",
                    cell: (s) => s.company?.trim() || "—",
                  },
                  {
                    id: "badge",
                    header: "Badge",
                    tdClassName: "text-muted-foreground",
                    cell: (s) => s.badgeId?.trim() || "—",
                  },
                  {
                    id: "clockIn",
                    header: "Clock in",
                    tdClassName: "text-muted-foreground",
                    cell: (s) => (s.clockInAt ? fmt(s.clockInAt) : "—"),
                  },
                  {
                    id: "clockOut",
                    header: "Clock out",
                    tdClassName: "text-muted-foreground",
                    cell: (s) => (s.clockOutAt ? fmt(s.clockOutAt) : <span className="text-amber-600">In progress</span>),
                  },
                  {
                    id: "hours",
                    header: "Hours",
                    align: "right",
                    mobile: "meta",
                    tdClassName: "tabular-nums",
                    cell: (s) => (s.hoursWorked != null ? Number(s.hoursWorked).toFixed(2) : "—"),
                    mobileCell: (s) => (
                      <span className="text-right tabular-nums text-sm">
                        {s.hoursWorked != null ? `${Number(s.hoursWorked).toFixed(2)} hrs` : "—"}
                      </span>
                    ),
                  },
                ]}
              />
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

      {site && canCreateShift && (
        <ShiftDialog
          open={creatingShift}
          onOpenChange={setCreatingShift}
          initial={shiftCreateInitial}
          onSaved={() => { setCreatingShift(false); setShiftMsg("New shift created for this site."); }}
        />
      )}

      {site && isAdmin && (
        <RepeatingShiftDialog
          open={repeatingShift}
          onOpenChange={setRepeatingShift}
          initialSiteId={site.id}
          onCreated={() => { setRepeatingShift(false); setShiftMsg("Repeating shifts created for this site."); }}
        />
      )}
    </div>
  );
}

// ============================================================ SITE RATE CARD
//
// Per-license-level pay+bill rates for this site. Shifts pull from this card
// during create/edit (with per-shift override), and invoice generation uses
// the resulting shift.billRate as the primary rate. Admin-only data — never
// rendered on officer-facing surfaces (commercial margin info).

type SiteRateRow = {
  id: string;
  siteId: string;
  licenseLevel: number;
  payRate: string;
  billRate: string;
  label: string | null;
};

const LEVEL_OPTIONS: { value: number; name: string }[] = [
  { value: 2, name: "L2 Unarmed" },
  { value: 3, name: "L3 Armed" },
  { value: 4, name: "L4 / PPO" },
];

function SiteRateCard({ siteId }: { siteId: string }) {
  const [rows, setRows] = useState<SiteRateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Draft form state for "add new rate" / "edit existing rate".
  const [draftLevel, setDraftLevel] = useState<number>(2);
  const [draftPay, setDraftPay] = useState<string>("");
  const [draftBill, setDraftBill] = useState<string>("");
  const [draftLabel, setDraftLabel] = useState<string>("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await api<SiteRateRow[]>(`/admin/sites/${siteId}/rates`);
      setRows(data ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => { void load(); }, [load]);

  async function saveDraft() {
    if (!draftLabel.trim()) {
      setErr("Label is required — it identifies this rate in shift pickers");
      return;
    }
    const pay = Number(draftPay);
    const bill = Number(draftBill);
    if (!Number.isFinite(pay) || pay < 0 || !Number.isFinite(bill) || bill < 0) {
      setErr("Pay and bill rates must be non-negative numbers");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api(`/admin/sites/${siteId}/rates`, {
        method: "PUT",
        body: JSON.stringify({
          ...(draftId ? { id: draftId } : {}),
          licenseLevel: draftLevel,
          payRate: pay,
          billRate: bill,
          label: draftLabel.trim(),
        }),
      });
      setDraftPay("");
      setDraftBill("");
      setDraftLabel("");
      setDraftId(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function editExisting(row: SiteRateRow) {
    // Track the id so PUT can UPDATE in-place, supporting label renames without
    // orphaning the old row or breaking shift.siteRateId back-references.
    setDraftId(row.id);
    setDraftLevel(row.licenseLevel);
    setDraftPay(String(parseFloat(row.payRate)));
    setDraftBill(String(parseFloat(row.billRate)));
    setDraftLabel(row.label ?? "");
  }

  async function removeRow(row: SiteRateRow) {
    const levelName = LEVEL_OPTIONS.find((o) => o.value === row.licenseLevel)?.name ?? `L${row.licenseLevel}`;
    const displayName = row.label ? `${levelName} — ${row.label}` : levelName;
    if (!confirm(`Remove the "${displayName}" rate for this site? Existing shifts that referenced it will keep their snapshotted pay/bill amounts.`)) return;
    try {
      await api(`/admin/site-rates/${row.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold inline-flex items-center gap-2">
          Rate card by license level
        </h2>
        <div className="text-xs text-muted-foreground">
          Pay (officer) and bill (client) rates per position. Shifts default to these; admin can override per shift.
        </div>
      </div>

      {err && (
        <div className="mb-3 text-sm text-destructive border border-destructive/40 rounded px-3 py-2">{err}</div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground border rounded p-4">
          No rates configured yet. Add the first license-level rate below — shifts at this site will pick it up automatically.
        </div>
      ) : (
        <ResponsiveTable
          data={rows}
          getRowKey={(r) => r.id}
          className="mb-3"
          columns={[
            {
              id: "level",
              header: "License level",
              mobile: "title",
              cell: (r) => LEVEL_OPTIONS.find((o) => o.value === r.licenseLevel)?.name ?? `L${r.licenseLevel}`,
            },
            {
              id: "label",
              header: "Label",
              mobile: "meta",
              tdClassName: "text-muted-foreground",
              cell: (r) => r.label ?? <span className="text-muted-foreground/60">—</span>,
              mobileCell: (r) => <span className="text-sm text-muted-foreground text-right">{r.label ?? "—"}</span>,
            },
            {
              id: "pay",
              header: "Pay $/hr",
              align: "right",
              tdClassName: "font-mono",
              mobileValueClassName: "font-mono",
              cell: (r) => `$${parseFloat(r.payRate).toFixed(2)}`,
            },
            {
              id: "bill",
              header: "Bill $/hr",
              align: "right",
              tdClassName: "font-mono",
              mobileValueClassName: "font-mono",
              cell: (r) => `$${parseFloat(r.billRate).toFixed(2)}`,
            },
            {
              id: "actions",
              header: "Actions",
              align: "right",
              mobile: "actions",
              cell: (r) => (
                <>
                  <Button variant="ghost" size="sm" onClick={() => editExisting(r)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => removeRow(r)}>
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                </>
              ),
              mobileCell: (r) => (
                <>
                  <Button variant="outline" size="sm" className="flex-1 min-w-[5rem]" onClick={() => editExisting(r)}>
                    <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1 min-w-[5rem]" onClick={() => removeRow(r)}>
                    <Trash2 className="w-3.5 h-3.5 text-destructive mr-1" /> Remove
                  </Button>
                </>
              ),
            },
          ]}
        />
      )}

      <div className="border rounded p-3 bg-brand-cream/20">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {draftId ? "Edit rate" : "Add rate"}
          </div>
          {draftId && (
            <button
              type="button"
              onClick={() => { setDraftId(null); setDraftPay(""); setDraftBill(""); setDraftLabel(""); }}
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            >
              Cancel edit
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
          <div>
            <label className="text-xs text-muted-foreground">License level</label>
            <select
              aria-label="License level"
              value={String(draftLevel)}
              onChange={(e) => setDraftLevel(Number(e.target.value))}
              className="w-full border rounded px-2 py-2 text-sm bg-background"
            >
              {LEVEL_OPTIONS.map((o) => (
                <option key={o.value} value={String(o.value)}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Label <span className="text-destructive">*</span></label>
            <input
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              placeholder="e.g. Day post"
              className="w-full border rounded px-2 py-2 text-sm bg-background"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Pay $/hr</label>
            <input
              aria-label="Pay rate dollars per hour"
              type="number" min="0" step="0.01"
              value={draftPay}
              onChange={(e) => setDraftPay(e.target.value)}
              className="w-full border rounded px-2 py-2 text-sm bg-background"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Bill $/hr</label>
            <input
              aria-label="Bill rate dollars per hour"
              type="number" min="0" step="0.01"
              value={draftBill}
              onChange={(e) => setDraftBill(e.target.value)}
              className="w-full border rounded px-2 py-2 text-sm bg-background"
            />
          </div>
          <Button onClick={saveDraft} disabled={saving || draftPay === "" || draftBill === ""}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            {saving ? "Saving…" : draftId ? "Update" : "Add"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ===================================================== SUBCONTRACTOR QR CARD
//
// One persistent QR code per site. Subcontractors scan it to clock in (and
// scan/submit again to clock out) without a WCSG account. The QR encodes a
// public toggle URL keyed by a per-site token. Rotating the token mints a new
// one and invalidates the old printed code.

type SubcontractorQr = {
  exists?: boolean;
  id?: string;
  token?: string;
  clockUrl?: string;
  siteName?: string;
  createdAt?: string;
};

function SubcontractorQrCard({ siteId, siteName }: { siteId: string; siteName: string }) {
  const [qr, setQr] = useState<SubcontractorQr | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await api<SubcontractorQr>(`/admin/sites/${siteId}/subcontractor-qr`);
      setQr(data ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => { void load(); }, [load]);

  async function generate(rotate: boolean) {
    setWorking(true);
    setErr(null);
    try {
      const data = await api<SubcontractorQr>(`/admin/sites/${siteId}/subcontractor-qr`, {
        method: "POST",
        body: JSON.stringify({ rotate }),
      });
      setQr({ ...data, exists: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(false);
    }
  }

  const clockUrl = qr?.exists && qr.clockUrl ? qr.clockUrl : null;

  useEffect(() => {
    if (!clockUrl || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, clockUrl, {
      width: 220,
      margin: 2,
      color: { dark: "#080c18", light: "#f0e6c8" },
    }).catch(() => {});
  }, [clockUrl]);

  function handlePrint() {
    if (!clockUrl || !canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL("image/png");
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`
      <html><head><title>Subcontractor QR — ${siteName}</title>
      <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0e6c8;color:#080c18}
      h1{font-size:18px;margin-bottom:4px}p{font-size:13px;margin:4px 0;opacity:.7}
      .url{font-size:11px;word-break:break-all;margin-top:12px;background:#fff;padding:8px;border-radius:6px}
      </style></head><body>
      <h1>Subcontractor Check-In</h1>
      <p>${siteName}</p>
      <img src="${dataUrl}" width="240" />
      <div class="url">${clockUrl}</div>
      <p style="margin-top:16px;font-size:11px">Scan to clock in or out</p>
      </body></html>`);
    win.document.close();
    win.print();
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold inline-flex items-center gap-2">
          <QrCode className="w-4 h-4" /> Subcontractor QR clock-in
        </h2>
        <div className="text-xs text-muted-foreground max-w-md text-right">
          One persistent code for this site. Subcontractors scan it to clock in, and scan again to clock out — no WCSG account needed.
        </div>
      </div>

      {err && (
        <div className="mb-3 text-sm text-destructive border border-destructive/40 rounded px-3 py-2">{err}</div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : clockUrl ? (
        <div className="border rounded p-4 flex flex-col sm:flex-row gap-4 items-center sm:items-start">
          <div className="flex justify-center p-3 rounded-lg shrink-0" style={{ background: "#f0e6c8" }}>
            <canvas ref={canvasRef} />
          </div>
          <div className="flex-1 min-w-0 space-y-3">
            <div className="text-xs text-muted-foreground space-y-1">
              <div className="break-all bg-muted/50 border rounded p-2 font-mono">{clockUrl}</div>
              {qr?.createdAt && <div>Created: {fmt(qr.createdAt)}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={handlePrint}>
                <Printer className="w-3.5 h-3.5 mr-1" /> Print
              </Button>
              <Button variant="outline" size="sm" onClick={() => generate(true)} disabled={working}>
                {working ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />}
                Rotate code
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              Rotating mints a new code and invalidates the old printed one.
            </div>
          </div>
        </div>
      ) : (
        <div className="border rounded p-4 space-y-3">
          <div className="text-sm text-muted-foreground">
            No QR code generated for this site yet. Create one for subcontractors to scan.
          </div>
          <Button
            size="sm"
            style={{ background: "#080c18", color: "#f0e6c8" }}
            onClick={() => generate(false)}
            disabled={working}
          >
            {working ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <QrCode className="w-3.5 h-3.5 mr-1" />}
            Generate QR code
          </Button>
        </div>
      )}
    </section>
  );
}
