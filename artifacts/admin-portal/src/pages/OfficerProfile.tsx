import { useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import { Radio } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useRoute, useLocation } from "wouter";
import { api } from "@/lib/api";
import { openSignedObject } from "@/lib/upload";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, User, Mail, Phone, ShieldCheck, AlertTriangle, Loader2,
  ExternalLink, MessageCircle, PhoneCall, Calendar, ShieldAlert, MapPin,
  Play, Pause, FileText, Shirt, ClipboardList, Briefcase, Banknote,
  BadgeCheck, Download,
} from "lucide-react";

type Officer = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  phone: string | null;
  maxLicenseLevel: number | null;
  licenseCount: number;
  expiringLicenseCount: number;
  // Full HR projection — present only for admins (the server strips these
  // for dispatchers via projectForDispatcher), so the full-profile block
  // below is additionally gated on the viewer's own admin role.
  position?: string | null;
  createdAt?: string | null;
  firstLoginAt?: string | null;
  lastLoginAt?: string | null;
  lastActiveAt?: string | null;
  address?: string | null;
  dateOfBirth?: string | null;
  cityOfBirth?: string | null;
  stateOfBirth?: string | null;
  niNumber?: string | null;
  rightToWorkStatus?: string | null;
  rightToWorkDocKey?: string | null;
  siaLicenseNumber?: string | null;
  siaLicenseLevel?: number | null;
  siaLicenseExpiry?: string | null;
  licenseDocKey?: string | null;
  passportDocKey?: string | null;
  previousExperience?: string | null;
  yearsExperience?: number | null;
  references?: unknown;
  photoKey?: string | null;
  cvKey?: string | null;
  trainingCertificateKeys?: unknown;
  availability?: unknown;
  emergencyContactName?: string | null;
  emergencyContactRelationship?: string | null;
  emergencyContactPhone?: string | null;
  hourlyRate?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankBsb?: string | null;
  taxCode?: string | null;
  payStubDocKey?: string | null;
  uniformShirt?: string | null;
  uniformTrousers?: string | null;
  uniformJacket?: string | null;
  uniformBoots?: string | null;
  directDepositConsent?: boolean | null;
  directDepositSignature?: string | null;
  acknowledgements?: unknown;
  skills?: string[] | null;
};

type ShiftAssignment = {
  id: string;
  employeeId: string;
  status: string;
};

type Shift = {
  id: string;
  title: string | null;
  startTime: string;
  endTime: string;
  status: string;
  location: string | null;
  clientName: string | null;
  siteId: string | null;
  assignments: ShiftAssignment[];
};

type Incident = {
  id: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  status: string;
  occurredAt: string | null;
  createdAt: string;
  locationDescription: string | null;
};

type ChatRoom = { id: string; name: string };

type TrailPoint = {
  lat: number;
  lng: number;
  capturedAt: string;
  timeEntryId: string | null;
};

type LiveLocation = {
  userId: string;
  lastLat: string | null;
  lastLng: string | null;
  lastLocationAt: string | null;
  clockedIn: boolean;
  clockInTime: string | null;
  shiftId: string | null;
  shiftTitle: string | null;
  site: {
    id: string;
    name: string;
    address: string | null;
    lat: number;
    lng: number;
    geofenceRadiusMiles: number;
  } | null;
  trail: TrailPoint[];
  trailWindow: "today" | "24h";
};

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "no ping";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * Render a sandboxed Leaflet iframe with the officer's pin and (when
 * clocked in) the active site's geofence circle. Coords are validated
 * floats; labels are JSON-escaped + injected into a sandboxed iframe with
 * `allow-scripts` only (no allow-same-origin) so nothing in here can read
 * the admin origin or pivot back into the parent.
 */
// Random value re-evaluated on every HMR reload of this module. Included in
// the iframe-srcdoc useMemo deps so that dev-time edits to the map template
// actually take effect without a hard refresh of the browser tab.
const MAP_BUILD_ID = Math.random().toString(36).slice(2, 10);

function buildOfficerMapHtml(
  officer: { lat: number; lng: number; label: string; sub: string },
  site: { lat: number; lng: number; name: string; radiusMiles: number } | null,
  trail: Array<{ lat: number; lng: number }>,
): string {
  const radiusMeters = site
    ? Math.max(10, Math.min(site.radiusMiles * 1609.344, 50_000))
    : 0;
  const data = JSON.stringify({ officer, site, radiusMeters, trail })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;padding:0;height:100%;background:#0c0a08}
.popup{font:13px -apple-system,system-ui,sans-serif}.popup b{color:#0c0a08}
.site-pin{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:5px;background:#0c0a08;color:#c9a04a;border:2px solid #c9a04a;font:bold 11px -apple-system,system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.35)}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const D = ${data};
function txt(label, sub){
  const w=document.createElement('div');w.className='popup';
  const b=document.createElement('b');b.appendChild(document.createTextNode(String(label||'')));
  w.appendChild(b);
  if (sub){ w.appendChild(document.createElement('br'));
    w.appendChild(document.createTextNode(String(sub))); }
  return w;
}
const map = L.map('m',{zoomControl:true});
// Leaflet requires a view (center + zoom) BEFORE any layer that needs
// projection (L.circle uses a metric radius and projects on add). Without
// this, adding a circle throws "Cannot read properties of undefined
// (reading 'layerPointToLatLng')". fitBounds below replaces this view.
map.setView([D.officer.lat, D.officer.lng], 14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'&copy; OpenStreetMap', maxZoom:19
}).addTo(map);
const group = L.featureGroup().addTo(map);
if (D.trail && D.trail.length >= 2) {
  L.polyline(D.trail.map(function(p){ return [p.lat, p.lng]; }), {
    color: '#3b82f6', weight: 3, opacity: 0.7,
  }).addTo(group);
}
if (D.site) {
  L.circle([D.site.lat, D.site.lng], {
    radius: D.radiusMeters, color:'#c9a04a', weight:1, opacity:0.5,
    fillColor:'#c9a04a', fillOpacity:0.08, interactive:false,
  }).addTo(group);
  const icon = L.divIcon({ className:'', html:'<div class="site-pin">S</div>',
    iconSize:[24,24], iconAnchor:[12,12] });
  L.marker([D.site.lat, D.site.lng], { icon })
    .bindPopup(txt(D.site.name, 'Active site'))
    .addTo(group);
}
const om = L.circleMarker([D.officer.lat, D.officer.lng], {
  radius: 10, color:'#10b981', fillColor:'#10b981', fillOpacity:0.9, weight:3,
}).bindPopup(txt(D.officer.label, D.officer.sub));
om.addTo(group);
// Replay marker: a gold pin the parent drives along the breadcrumb via
// postMessage. The iframe is sandboxed (allow-scripts only, no
// allow-same-origin) so the parent can still postMessage in; we accept any
// origin because this is a same-app internal control channel and the
// payload is coordinate-only. Messages are coordinate-validated before use.
var replayMarker = null;
window.addEventListener('message', function(e){
  var m = e && e.data;
  if (!m || m.type !== 'replay') return;
  if (m.show === false){
    if (replayMarker){ map.removeLayer(replayMarker); replayMarker = null; }
    return;
  }
  if (typeof m.lat !== 'number' || typeof m.lng !== 'number'
      || !isFinite(m.lat) || !isFinite(m.lng)) return;
  if (!replayMarker){
    replayMarker = L.circleMarker([m.lat, m.lng], {
      radius: 9, color:'#c9a04a', fillColor:'#c9a04a', fillOpacity:0.95,
      weight:3,
    }).addTo(map);
    replayMarker.bindTooltip('', {
      permanent:true, direction:'top', offset:[0,-8], className:'',
    });
  } else {
    replayMarker.setLatLng([m.lat, m.lng]);
  }
  replayMarker.setTooltipContent(String(m.label || ''));
});
// Compute fit bounds manually instead of group.getBounds(). FeatureGroup
// iterates child layers and calls .getBounds() on each, which for L.circle
// hits Circle.js:62 (this._map.layerPointToLatLng) and has thrown
// "Cannot read properties of undefined" in this sandboxed iframe even after
// .addTo(group). A lat/lng box, expanded by site radius, is bulletproof.
const _bb = L.latLngBounds([]);
_bb.extend([D.officer.lat, D.officer.lng]);
if (D.trail && D.trail.length) {
  D.trail.forEach(function(p){ _bb.extend([p.lat, p.lng]); });
}
if (D.site) {
  var _cosLat = Math.cos(D.site.lat * Math.PI / 180);
  var _dLat = D.radiusMeters / 111320;
  var _dLng = D.radiusMeters / (111320 * Math.max(0.01, _cosLat));
  _bb.extend([D.site.lat - _dLat, D.site.lng - _dLng]);
  _bb.extend([D.site.lat + _dLat, D.site.lng + _dLng]);
}
if (_bb.isValid()) map.fitBounds(_bb.pad(0.4), { maxZoom: 16 });
</script></body></html>`;
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-600 text-white",
  inactive: "bg-slate-400 text-white",
  pending: "bg-amber-500 text-black",
};

const SEV_TONE: Record<Incident["severity"], string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-yellow-500 text-black",
  low: "bg-slate-400 text-white",
};

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

// Compact clock used by the replay scrubber — weekday + HH:MM:SS so a
// dispatcher can read "where was she at 9:42:15pm" off the slider.
function fmtClock(t: number): string {
  return new Date(t).toLocaleString(undefined, {
    weekday: "short", hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}

function startOfToday(): Date {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d;
}
function endOfToday(): Date {
  const d = new Date(); d.setHours(23, 59, 59, 999); return d;
}

// ── Full-profile helpers (admin-only HR view) ───────────────────────────
function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtRate(v: string | number | null | undefined): string | null {
  if (v == null || v === "") return null;
  const num = Number(v);
  return Number.isFinite(num) ? `$${num.toFixed(2)}/hr` : String(v);
}

function titleCase(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function yesNo(v: boolean | null | undefined): string | null {
  return v == null ? null : v ? "Yes" : "No";
}

// Bank account numbers are masked to the last 4 digits in this read-only
// view; full banking detail stays in the editable Personnel grid.
function maskTail(v: string | null | undefined, keep = 4): string | null {
  if (!v) return null;
  const s = String(v);
  if (s.length <= keep) return "•".repeat(s.length);
  return "••••" + s.slice(-keep);
}

function renderReferences(refs: unknown): ReactNode {
  if (!refs) return <span className="opacity-50">—</span>;
  const arr = Array.isArray(refs) ? refs : [refs];
  if (arr.length === 0) return <span className="opacity-50">—</span>;
  return (
    <ul className="space-y-1">
      {arr.map((r, i) => {
        if (r && typeof r === "object") {
          const o = r as Record<string, unknown>;
          const parts = [o.name, o.relationship, o.company, o.phone, o.email]
            .filter((x) => x != null && x !== "")
            .map(String);
          return <li key={i}>{parts.length ? parts.join(" · ") : JSON.stringify(r)}</li>;
        }
        return <li key={i}>{String(r)}</li>;
      })}
    </ul>
  );
}

function renderAvailability(av: unknown): ReactNode {
  if (!av) return <span className="opacity-50">—</span>;
  if (typeof av === "string") return av || <span className="opacity-50">—</span>;
  if (Array.isArray(av)) {
    if (av.length === 0) return <span className="opacity-50">—</span>;
    return av.map((x) => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  }
  if (typeof av === "object") {
    const on = Object.entries(av as Record<string, unknown>)
      .filter(([, v]) => v === true || (typeof v === "string" && v))
      .map(([k, v]) => (v === true ? titleCase(k) : `${titleCase(k)}: ${v}`));
    return on.length ? on.join(", ") : <span className="opacity-50">—</span>;
  }
  return String(av);
}

function renderAcks(ack: unknown): ReactNode {
  if (!ack) return <span className="opacity-50">—</span>;
  if (Array.isArray(ack)) {
    return ack.length ? (
      <ul className="space-y-0.5">
        {ack.map((a, i) => (
          <li key={i}>✓ {a && typeof a === "object" ? JSON.stringify(a) : String(a)}</li>
        ))}
      </ul>
    ) : <span className="opacity-50">—</span>;
  }
  if (typeof ack === "object") {
    const entries = Object.entries(ack as Record<string, unknown>);
    return entries.length ? (
      <ul className="space-y-0.5">
        {entries.map(([k, v]) => <li key={k}>{v ? "✓" : "✗"} {titleCase(k)}</li>)}
      </ul>
    ) : <span className="opacity-50">—</span>;
  }
  return String(ack);
}

// trainingCertificateKeys is freeform jsonb — accept an array of plain object
// keys (strings) or {objectPath|key|docKey, name|filename|label} entries.
function certEntries(v: unknown): Array<{ label: string; key: string }> {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: Array<{ label: string; key: string }> = [];
  arr.forEach((item, i) => {
    if (typeof item === "string" && item) {
      out.push({ label: `Certificate ${i + 1}`, key: item });
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const key = (o.objectPath ?? o.key ?? o.docKey) as string | undefined;
      const label = (o.name ?? o.filename ?? o.label) as string | undefined;
      if (key) out.push({ label: label ?? `Certificate ${i + 1}`, key });
    }
  });
  return out;
}

/** A labelled read-only field; renders an em-dash when the value is empty. */
function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase opacity-60">{label}</div>
      <div className="text-sm break-words">
        {empty ? <span className="opacity-50">—</span> : value}
      </div>
    </div>
  );
}

/** A document field that opens the private object via a short-lived signed URL. */
function DocButton({ label, objectKey }: { label: string; objectKey: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase opacity-60">{label}</div>
      {objectKey ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 mt-0.5"
          onClick={() => { void openSignedObject(objectKey); }}
        >
          <FileText className="w-3.5 h-3.5 mr-1" /> View
        </Button>
      ) : (
        <div className="text-sm opacity-50">— not on file</div>
      )}
    </div>
  );
}

/**
 * Officer profile page reachable from the Dispatch Live Map "View profile"
 * popup action and the personnel roster. Both dispatchers and admins can
 * open it; `GET /employees/:id` is role-aware, so dispatchers see only the
 * operational-safe projection.
 *
 * Read-only profile data — but dispatchers can act from here: open a DM,
 * dial the officer, or jump to today's shift / recent incidents.
 */
export default function OfficerProfilePage() {
  const [, params] = useRoute<{ id: string }>("/personnel/:id");
  const [, navigate] = useLocation();
  const id = params?.id ?? "";
  // Pay Run handoff: the PNC readiness dialog links here with
  // `?payrun=<csv of payroll entry ids>` so the admin can fix bank details and
  // hop straight back to the same selected batch. Parsed once at mount —
  // wouter navigation within the page doesn't rewrite the search string.
  const payrunReturnIds = useMemo(() => {
    if (typeof window === "undefined") return "";
    const raw = new URLSearchParams(window.location.search).get("payrun") ?? "";
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(",");
  }, []);
  // Full HR profile is admin-only. Dispatchers reach this same route from the
  // Live Map but the server already strips sensitive fields for them; this
  // gate keeps the full-profile block from rendering even if that changes.
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const officer = useQuery<Officer>({
    queryKey: ["officer", id],
    queryFn: () => api<Officer>(`/employees/${encodeURIComponent(id)}`),
    enabled: !!id,
  });

  // Today's shift window covers anything scheduled to start today or
  // currently in progress that started earlier. We pull a slightly wider
  // window (start of today through end of today) and let the UI pick the
  // best row to highlight as "now".
  const todaysShifts = useQuery<Shift[]>({
    queryKey: ["officer-shifts-today", id],
    queryFn: () => {
      const from = startOfToday().toISOString();
      const to = endOfToday().toISOString();
      return api<Shift[]>(
        `/shifts?employeeId=${encodeURIComponent(id)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
    },
    enabled: !!id,
  });

  // Trail window toggle — "today" by default, "24h" expands to the
  // rolling 24-hour breadcrumb so dispatchers can review where the
  // officer was even after they clocked out.
  const [trailWindow, setTrailWindow] = useState<"today" | "24h">("today");

  // Trail replay scrubber. `scrubT` is a timestamp (ms) between the first and
  // last breadcrumb ping; `null` means "follow live" (no replay, normal pin).
  // While replaying we drive a gold marker inside the iframe via postMessage
  // and pause the 30s auto-refetch so the map doesn't reload mid-scrub.
  const [scrubT, setScrubT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 5 | 30>(5);
  const mapIframeRef = useRef<HTMLIFrameElement | null>(null);
  const replayEngaged = scrubT !== null;

  // Live location refreshes every 30s — same cadence as the Dispatch Live
  // Map — so dispatchers staying on this page during an active call see
  // fresh pings without manual refresh. Paused while a dispatcher is
  // scrubbing/replaying so the sandboxed iframe isn't torn down mid-replay.
  const liveLocation = useQuery<LiveLocation>({
    queryKey: ["officer-live", id, trailWindow],
    queryFn: () => api<LiveLocation>(
      `/admin/officers/${encodeURIComponent(id)}/live?window=${trailWindow}`,
    ),
    enabled: !!id,
    refetchInterval: replayEngaged ? false : 30_000,
  });

  const recentIncidents = useQuery<Incident[]>({
    queryKey: ["officer-incidents-recent", id],
    queryFn: () => api<Incident[]>(`/incidents?employeeId=${encodeURIComponent(id)}`),
    enabled: !!id,
  });

  // Send-message handler: idempotently open/create the 1:1 DM, then
  // deep-link the existing /chat?room=<id> route.
  const openDm = useMutation<ChatRoom, Error, void>({
    mutationFn: async () =>
      api<ChatRoom>("/chat/direct", {
        method: "POST",
        body: JSON.stringify({ otherUserId: id }),
      }),
    onSuccess: (room) => navigate(`/chat?room=${encodeURIComponent(room.id)}`),
  });

  // Pick the most relevant shift to surface as "today's shift":
  // 1) an in-progress shift (start ≤ now ≤ end)
  // 2) the next shift starting later today
  // 3) otherwise nothing
  const todaysShift = useMemo<Shift | null>(() => {
    const rows = todaysShifts.data ?? [];
    if (rows.length === 0) return null;
    const now = Date.now();
    const sorted = [...rows].sort((a, b) =>
      new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    const active = sorted.find((s) =>
      new Date(s.startTime).getTime() <= now && new Date(s.endTime).getTime() >= now);
    if (active) return active;
    const upcoming = sorted.find((s) => new Date(s.startTime).getTime() > now);
    return upcoming ?? sorted[sorted.length - 1] ?? null;
  }, [todaysShifts.data]);

  // Parsed officer lat/lng (numeric form, validated). Used both for the
  // text "last ping" line and as the map pin. Anything that fails parsing
  // is treated as "no recent ping" — same posture as Dispatch.
  const officerCoord = useMemo<{ lat: number; lng: number } | null>(() => {
    const d = liveLocation.data;
    if (!d?.lastLat || !d?.lastLng) return null;
    const lat = parseFloat(d.lastLat);
    const lng = parseFloat(d.lastLng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng };
  }, [liveLocation.data]);

  // Render the embedded map whenever we have a usable officer pin. When
  // clocked in we draw the active site circle; when off-shift we still
  // show the pin + breadcrumb so the "last 24h" toggle has somewhere to
  // paint the trail.
  const mapHtml = useMemo<string | null>(() => {
    const d = liveLocation.data;
    if (!d || !officerCoord) return null;
    const label = officer.data
      ? `${officer.data.firstName} ${officer.data.lastName}`
      : "Officer";
    const sub = d.clockedIn
      ? `${d.site?.name ?? d.shiftTitle ?? "on shift"} · ${fmtAgo(d.lastLocationAt)}`
      : `Off duty · last ping ${fmtAgo(d.lastLocationAt)}`;
    const site = d.clockedIn && d.site
      ? { lat: d.site.lat, lng: d.site.lng, name: d.site.name, radiusMiles: d.site.geofenceRadiusMiles }
      : null;
    const trail = (d.trail ?? [])
      .map((p) => ({ lat: p.lat, lng: p.lng }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    return buildOfficerMapHtml(
      { lat: officerCoord.lat, lng: officerCoord.lng, label, sub },
      site,
      trail,
    );
    // MAP_BUILD_ID re-evaluates on every HMR reload so dev-time edits to
    // buildOfficerMapHtml actually take effect without a hard refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveLocation.data, officerCoord, officer.data, MAP_BUILD_ID]);

  // Breadcrumb points usable for replay: finite coords + timestamps, sorted
  // chronologically. Same source as the polyline, but carries the time axis
  // the scrubber rides along.
  const replayTrail = useMemo(() => {
    return (liveLocation.data?.trail ?? [])
      .map((p) => ({ lat: p.lat, lng: p.lng, t: new Date(p.capturedAt).getTime() }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t);
  }, [liveLocation.data]);

  const tMin = replayTrail.length ? replayTrail[0].t : 0;
  const tMax = replayTrail.length ? replayTrail[replayTrail.length - 1].t : 0;
  const canReplay = replayTrail.length >= 2 && tMax > tMin;

  // Interpolate the officer's position at an arbitrary timestamp by walking
  // the breadcrumb segments and lerping between the two surrounding pings.
  const posAt = useMemo(() => {
    return (t: number): { lat: number; lng: number } => {
      if (replayTrail.length === 0) return { lat: 0, lng: 0 };
      if (t <= replayTrail[0].t) return replayTrail[0];
      const last = replayTrail[replayTrail.length - 1];
      if (t >= last.t) return last;
      for (let i = 0; i < replayTrail.length - 1; i++) {
        const a = replayTrail[i];
        const b = replayTrail[i + 1];
        if (t >= a.t && t <= b.t) {
          const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
          return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
        }
      }
      return last;
    };
  }, [replayTrail]);

  // Reset the scrubber whenever the trail window changes — the time axis
  // (and the underlying breadcrumb) is now different.
  useEffect(() => {
    setScrubT(null);
    setPlaying(false);
  }, [trailWindow]);

  // Playback loop: advance the scrub clock by `speed × elapsed` each tick so
  // 1× is wall-clock, 5×/30× compress the trail. Stops at the last ping.
  useEffect(() => {
    if (!playing || !canReplay) return;
    const STEP_MS = 100;
    const handle = window.setInterval(() => {
      setScrubT((prev) => {
        const base = prev == null ? tMin : prev;
        const next = base + speed * STEP_MS;
        if (next >= tMax) {
          setPlaying(false);
          return tMax;
        }
        return next;
      });
    }, STEP_MS);
    return () => window.clearInterval(handle);
  }, [playing, canReplay, speed, tMin, tMax]);

  // Drive the gold replay marker inside the sandboxed iframe via postMessage.
  // When not replaying (scrubT null) we tell the iframe to hide the marker.
  useEffect(() => {
    const win = mapIframeRef.current?.contentWindow;
    if (!win) return;
    if (scrubT == null || !canReplay) {
      win.postMessage({ type: "replay", show: false }, "*");
      return;
    }
    const p = posAt(scrubT);
    win.postMessage(
      { type: "replay", show: true, lat: p.lat, lng: p.lng, label: fmtClock(scrubT) },
      "*",
    );
  }, [scrubT, canReplay, posAt]);

  const recent5 = useMemo<Incident[]>(() => {
    const rows = recentIncidents.data ?? [];
    return [...rows]
      .sort((a, b) =>
        new Date(b.occurredAt ?? b.createdAt).getTime() -
        new Date(a.occurredAt ?? a.createdAt).getTime())
      .slice(0, 5);
  }, [recentIncidents.data]);

  const [pdfBusy, setPdfBusy] = useState<"view" | "download" | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  async function openProfilePdf(mode: "view" | "download") {
    if (!id || pdfBusy) return;
    setPdfBusy(mode);
    setPdfError(null);
    try {
      const { token } = await api<{ token: string }>(
        `/employees/${encodeURIComponent(id)}/profile/pdf/download-token`,
        { method: "POST" },
      );
      const res = await fetch(
        `/api/employees/${encodeURIComponent(id)}/profile/pdf?token=${encodeURIComponent(token)}`,
      );
      if (!res.ok) {
        let msg = `Could not generate PDF (${res.status})`;
        try { const j = await res.json(); if (j?.message) msg = j.message; } catch { /* not JSON */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (mode === "view") {
        window.open(url, "_blank", "noopener");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        const disp = res.headers.get("Content-Disposition") ?? "";
        const m = /filename="?([^";]+)"?/.exec(disp);
        const filename = m?.[1] ?? `profile-${id}.pdf`;
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : "PDF generation failed.");
    } finally {
      setPdfBusy(null);
    }
  }

  return (
    <div className="p-4 lg:p-6 max-w-[1000px] mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <Link href="/personnel">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-1" /> Personnel
          </Button>
        </Link>
        <Link href="/dispatch">
          <Button variant="ghost" size="sm" className="opacity-70">
            <ArrowLeft className="w-4 h-4 mr-1" /> Dispatch
          </Button>
        </Link>
      </div>

      {payrunReturnIds && (
        <div className="rounded border border-blue-300 bg-blue-50 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-sm text-blue-900">
          <span>
            You came here from a Pay Run batch. After saving the fix, head back
            and re-run the readiness check.
          </span>
          <Link
            href={`/payroll/pay-run?ids=${encodeURIComponent(payrunReturnIds)}`}
            className="shrink-0"
          >
            <Button
              size="sm"
              className="bg-blue-700 text-white hover:bg-blue-800"
              data-testid="back-to-pay-run"
            >
              <Banknote className="w-4 h-4 mr-1" /> Back to Pay Run batch
            </Button>
          </Link>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <User className="w-5 h-5 brand-gold" />
            Officer profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          {officer.isLoading && (
            <div className="text-sm opacity-60 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {officer.error && (
            <div className="rounded border border-red-200 bg-red-50 text-red-900 text-xs px-3 py-2 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5" />
              {officer.error instanceof Error ? officer.error.message : "Could not load officer."}
            </div>
          )}
          {officer.data && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="text-xl font-semibold brand-wordmark">
                  {officer.data.lastName}, {officer.data.firstName}
                </div>
                <Badge className={`text-[10px] uppercase ${STATUS_TONE[officer.data.status] ?? "bg-slate-400 text-white"}`}>
                  {officer.data.status}
                </Badge>
                <Badge className="bg-brand-navy text-brand-gold uppercase text-[10px]">
                  {officer.data.role}
                </Badge>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => openDm.mutate()}
                  disabled={openDm.isPending}
                  data-testid="officer-send-message"
                >
                  {openDm.isPending ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <MessageCircle className="w-4 h-4 mr-1" />
                  )}
                  Send message
                </Button>
                {officer.data.phone ? (
                  <a href={`tel:${officer.data.phone}`} data-testid="officer-call">
                    <Button size="sm" variant="outline">
                      <PhoneCall className="w-4 h-4 mr-1" />
                      Call {officer.data.phone}
                    </Button>
                  </a>
                ) : (
                  <Button size="sm" variant="outline" disabled title="No phone on file">
                    <PhoneCall className="w-4 h-4 mr-1" />
                    No phone on file
                  </Button>
                )}
                {isAdmin && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void openProfilePdf("view")}
                      disabled={!!pdfBusy}
                      title="Open profile PDF in a new tab"
                    >
                      {pdfBusy === "view" ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : (
                        <FileText className="w-4 h-4 mr-1" />
                      )}
                      View PDF
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void openProfilePdf("download")}
                      disabled={!!pdfBusy}
                      title="Download profile PDF"
                    >
                      {pdfBusy === "download" ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4 mr-1" />
                      )}
                      Download PDF
                    </Button>
                  </>
                )}
              </div>
              {openDm.error && (
                <div className="text-xs text-red-700">
                  Could not open chat: {openDm.error.message}
                </div>
              )}
              {pdfError && (
                <div className="flex items-center gap-1.5 text-xs text-red-700">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  {pdfError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="rounded border p-3 flex items-start gap-2">
                  <Mail className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Email</div>
                    <a className="underline truncate block" href={`mailto:${officer.data.email}`}>
                      {officer.data.email}
                    </a>
                  </div>
                </div>
                <div className="rounded border p-3 flex items-start gap-2">
                  <Phone className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Phone</div>
                    {officer.data.phone ? (
                      <a className="underline" href={`tel:${officer.data.phone}`}>{officer.data.phone}</a>
                    ) : (
                      <span className="opacity-60">—</span>
                    )}
                  </div>
                </div>
                <div className="rounded border p-3 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Max licence</div>
                    <div>
                      {officer.data.maxLicenseLevel == null
                        ? <span className="opacity-50">none on file</span>
                        : `L${officer.data.maxLicenseLevel}${officer.data.maxLicenseLevel === 4 ? " / PPO" : ""}`}
                    </div>
                  </div>
                </div>
                <div className="rounded border p-3 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Licences</div>
                    <div>
                      {officer.data.licenseCount}
                      {officer.data.expiringLicenseCount > 0 && (
                        <span className="ml-1.5 text-amber-700">
                          · {officer.data.expiringLicenseCount} expiring within 30d
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="text-xs opacity-60">
                Read-only. To edit this officer, open the admin Personnel grid.
                <Link href="/personnel">
                  <Button variant="link" size="sm" className="text-xs h-auto p-0 ml-2">
                    Open roster <ExternalLink className="w-3 h-3 ml-1" />
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {isAdmin && officer.data && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Briefcase className="w-5 h-5 brand-gold" />
                Employment &amp; identity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <Field label="Position" value={titleCase(officer.data.position)} />
                <Field label="Hourly rate" value={fmtRate(officer.data.hourlyRate)} />
                <Field label="Date added" value={fmtDate(officer.data.createdAt)} />
                <Field label="Date of birth" value={fmtDate(officer.data.dateOfBirth)} />
                <Field label="City of birth" value={officer.data.cityOfBirth} />
                <Field label="State of birth" value={officer.data.stateOfBirth} />
                <Field label="SSN (last 4)" value={officer.data.niNumber} />
                <Field label="First login" value={fmtDate(officer.data.firstLoginAt)} />
                <Field label="Last login" value={fmtDate(officer.data.lastLoginAt)} />
              </div>
              <Field label="Address" value={officer.data.address} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <BadgeCheck className="w-5 h-5 brand-gold" />
                Right to work &amp; licence
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <Field label="Right to work" value={titleCase(officer.data.rightToWorkStatus)} />
                <Field label="TX licence #" value={officer.data.siaLicenseNumber} />
                <Field
                  label="Licence level"
                  value={officer.data.siaLicenseLevel != null ? `L${officer.data.siaLicenseLevel}` : null}
                />
                <Field label="Licence expiry" value={fmtDate(officer.data.siaLicenseExpiry)} />
                <DocButton label="Right-to-work doc" objectKey={officer.data.rightToWorkDocKey} />
                <DocButton label="Licence doc" objectKey={officer.data.licenseDocKey} />
                <DocButton label="Passport doc" objectKey={officer.data.passportDocKey} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Briefcase className="w-5 h-5 brand-gold" />
                Experience &amp; skills
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <Field label="Years experience" value={officer.data.yearsExperience} />
                <Field label="Skills" value={(officer.data.skills ?? []).join(", ") || null} />
              </div>
              <Field label="Previous experience" value={officer.data.previousExperience} />
              <div>
                <div className="text-[11px] uppercase opacity-60">References</div>
                <div className="text-sm">{renderReferences(officer.data.references)}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Phone className="w-5 h-5 brand-gold" />
                Emergency contact
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <Field label="Name" value={officer.data.emergencyContactName} />
                <Field label="Relationship" value={officer.data.emergencyContactRelationship} />
                <Field label="Phone (call only)" value={officer.data.emergencyContactPhone} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Banknote className="w-5 h-5 brand-gold" />
                Pay &amp; banking
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <Field label="Hourly rate" value={fmtRate(officer.data.hourlyRate)} />
                <Field label="Account name" value={officer.data.bankAccountName} />
                <Field label="Account number" value={maskTail(officer.data.bankAccountNumber)} />
                <Field label="Routing / BSB" value={officer.data.bankBsb} />
                <Field label="Tax code" value={officer.data.taxCode} />
                <Field label="Direct deposit consent" value={yesNo(officer.data.directDepositConsent)} />
                <Field label="DD signature" value={officer.data.directDepositSignature} />
                <DocButton label="W-2 / pay stub" objectKey={officer.data.payStubDocKey} />
              </div>
              <div className="mt-2 text-[11px] opacity-50">
                Account number masked to last 4. Full banking detail is editable in the Personnel grid.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Shirt className="w-5 h-5 brand-gold" />
                Uniform sizes
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
                <Field label="Shirt" value={officer.data.uniformShirt} />
                <Field label="Trousers" value={officer.data.uniformTrousers} />
                <Field label="Jacket" value={officer.data.uniformJacket} />
                <Field label="Boots" value={officer.data.uniformBoots} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="w-5 h-5 brand-gold" />
                Documents
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <DocButton label="Photo" objectKey={officer.data.photoKey} />
                <DocButton label="CV / résumé" objectKey={officer.data.cvKey} />
              </div>
              <div className="mt-3">
                <div className="text-[11px] uppercase opacity-60 mb-1">Training certificates</div>
                {certEntries(officer.data.trainingCertificateKeys).length === 0 ? (
                  <div className="text-sm opacity-50">— none on file</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {certEntries(officer.data.trainingCertificateKeys).map((c, i) => (
                      <Button
                        key={i}
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => { void openSignedObject(c.key); }}
                      >
                        <FileText className="w-3.5 h-3.5 mr-1" /> {c.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardList className="w-5 h-5 brand-gold" />
                Availability &amp; acknowledgements
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="text-[11px] uppercase opacity-60">Availability</div>
                <div className="text-sm">{renderAvailability(officer.data.availability)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase opacity-60">Acknowledgements</div>
                <div className="text-sm">{renderAcks(officer.data.acknowledgements)}</div>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="w-5 h-5 brand-gold" />
            Live location
            {liveLocation.data?.clockedIn && (
              <Badge className="bg-emerald-600 text-white text-[10px] uppercase">
                on duty
              </Badge>
            )}
            <span className="ml-auto text-xs opacity-60 font-normal">
              {liveLocation.isFetching ? "refreshing…" : fmtAgo(liveLocation.data?.lastLocationAt)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {liveLocation.isLoading && (
            <div className="text-sm opacity-60 px-4 pb-4 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {liveLocation.error && (
            <div className="text-xs text-red-700 px-4 pb-4">
              Could not load location:{" "}
              {liveLocation.error instanceof Error ? liveLocation.error.message : "unknown error"}
            </div>
          )}
          {liveLocation.data && !liveLocation.isLoading && (
            <>
              <div className="text-sm px-4 pb-3 space-y-1">
                {officerCoord ? (
                  <div className="flex items-center gap-1 flex-wrap" data-testid="officer-last-ping">
                    <MapPin className="w-3.5 h-3.5 brand-gold" />
                    <span className="font-mono text-xs">
                      {officerCoord.lat.toFixed(5)}, {officerCoord.lng.toFixed(5)}
                    </span>
                    <span className="opacity-70">
                      · last ping {fmtAgo(liveLocation.data.lastLocationAt)}
                    </span>
                  </div>
                ) : (
                  <div className="opacity-60">No location ping on file yet.</div>
                )}
                {liveLocation.data.clockedIn && liveLocation.data.site && (
                  <div className="opacity-70 text-xs">
                    Active site: <span className="font-medium">{liveLocation.data.site.name}</span>
                    {" · "}geofence {liveLocation.data.site.geofenceRadiusMiles.toFixed(2)} mi
                  </div>
                )}
                {liveLocation.data.clockedIn && !liveLocation.data.site && (
                  <div className="opacity-60 text-xs">
                    Clocked in, but no site coordinates — map can't draw a perimeter.
                  </div>
                )}
                {!liveLocation.data.clockedIn && officerCoord && (
                  <div className="opacity-60 text-xs">
                    Not currently clocked in — pin reflects the last known position.
                  </div>
                )}
                <div className="flex items-center gap-2 pt-1" data-testid="officer-trail-toggle">
                  <span className="text-[11px] uppercase opacity-60">Trail</span>
                  <div className="inline-flex rounded border overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setTrailWindow("today")}
                      className={`px-2 py-0.5 text-xs ${trailWindow === "today" ? "bg-brand-navy text-brand-gold" : "opacity-70 hover:opacity-100"}`}
                      data-testid="officer-trail-today"
                    >
                      Today
                    </button>
                    <button
                      type="button"
                      onClick={() => setTrailWindow("24h")}
                      className={`px-2 py-0.5 text-xs border-l ${trailWindow === "24h" ? "bg-brand-navy text-brand-gold" : "opacity-70 hover:opacity-100"}`}
                      data-testid="officer-trail-24h"
                    >
                      Last 24h
                    </button>
                  </div>
                  <span className="text-xs opacity-60">
                    {liveLocation.data.trail?.length ?? 0} ping
                    {(liveLocation.data.trail?.length ?? 0) === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              {mapHtml && (
                <iframe
                  ref={mapIframeRef}
                  key={`officer-map-${MAP_BUILD_ID}`}
                  title="Officer live location"
                  srcDoc={mapHtml}
                  className="w-full h-64 border-0 border-t"
                  sandbox="allow-scripts"
                  data-testid="officer-live-map"
                />
              )}
              {mapHtml && canReplay && (
                <div
                  className="px-4 py-3 border-t space-y-2"
                  data-testid="officer-replay-controls"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      onClick={() => {
                        if (playing) {
                          setPlaying(false);
                          return;
                        }
                        // Start from the beginning when at (or past) the end.
                        setScrubT((prev) =>
                          prev == null || prev >= tMax ? tMin : prev,
                        );
                        setPlaying(true);
                      }}
                      data-testid="officer-replay-play"
                    >
                      {playing ? (
                        <Pause className="w-3.5 h-3.5 mr-1" />
                      ) : (
                        <Play className="w-3.5 h-3.5 mr-1" />
                      )}
                      {playing ? "Pause" : "Play"}
                    </Button>
                    <div className="inline-flex rounded border overflow-hidden">
                      {([1, 5, 30] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setSpeed(s)}
                          className={`px-2 py-0.5 text-xs ${s !== 1 ? "border-l" : ""} ${speed === s ? "bg-brand-navy text-brand-gold" : "opacity-70 hover:opacity-100"}`}
                          data-testid={`officer-replay-speed-${s}`}
                        >
                          {s}×
                        </button>
                      ))}
                    </div>
                    <span
                      className="ml-auto text-xs font-mono opacity-80"
                      data-testid="officer-replay-time"
                    >
                      {replayEngaged ? fmtClock(scrubT as number) : "live"}
                    </span>
                    {replayEngaged && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => {
                          setPlaying(false);
                          setScrubT(null);
                        }}
                        data-testid="officer-replay-live"
                      >
                        Back to live
                      </Button>
                    )}
                  </div>
                  <input
                    type="range"
                    min={tMin}
                    max={tMax}
                    step={1000}
                    value={scrubT ?? tMax}
                    onChange={(e) => {
                      setPlaying(false);
                      setScrubT(Number(e.target.value));
                    }}
                    className="w-full accent-[#c9a04a]"
                    aria-label="Trail replay time slider"
                    data-testid="officer-replay-slider"
                  />
                  <div className="flex justify-between text-[10px] opacity-60 font-mono">
                    <span>{fmtClock(tMin)}</span>
                    <span>{fmtClock(tMax)}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Calendar className="w-5 h-5 brand-gold" />
            Today's shift
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {todaysShifts.isLoading && (
            <div className="opacity-60 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {todaysShifts.error && (
            <div className="text-xs text-red-700">
              Could not load shifts: {todaysShifts.error instanceof Error ? todaysShifts.error.message : "unknown error"}
            </div>
          )}
          {!todaysShifts.isLoading && !todaysShift && (
            <div className="opacity-60">No shifts scheduled today.</div>
          )}
          {todaysShift && (
            <div className="space-y-1">
              <div className="font-medium">{todaysShift.title ?? "Untitled shift"}</div>
              <div className="opacity-80">
                {fmtDateTime(todaysShift.startTime)} — {fmtDateTime(todaysShift.endTime)}
              </div>
              {(todaysShift.clientName || todaysShift.location) && (
                <div className="opacity-70 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />
                  {[todaysShift.clientName, todaysShift.location].filter(Boolean).join(" · ")}
                </div>
              )}
              <div className="pt-1">
                <Link href={`/admin/tables/shifts?focus=${encodeURIComponent(todaysShift.id)}`}>
                  <Button variant="link" size="sm" className="text-xs h-auto p-0">
                    Open shift <ExternalLink className="w-3 h-3 ml-1" />
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="w-5 h-5 brand-gold" />
            Recent incidents
            {recent5.length > 0 && (
              <span className="ml-auto text-xs opacity-60 font-normal">
                last {recent5.length}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {recentIncidents.isLoading && (
            <div className="opacity-60 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {recentIncidents.error && (
            <div className="text-xs text-red-700">
              Could not load incidents: {recentIncidents.error instanceof Error ? recentIncidents.error.message : "unknown error"}
            </div>
          )}
          {!recentIncidents.isLoading && recent5.length === 0 && (
            <div className="opacity-60">No incidents on file.</div>
          )}
          {recent5.length > 0 && (
            <ul className="divide-y">
              {recent5.map((inc) => (
                <li key={inc.id} className="py-2 flex items-start gap-3">
                  <Badge className={`text-[10px] uppercase shrink-0 ${SEV_TONE[inc.severity]}`}>
                    {inc.severity}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{inc.title}</div>
                    <div className="text-xs opacity-70">
                      {fmtDateTime(inc.occurredAt ?? inc.createdAt)}
                      {inc.locationDescription ? ` · ${inc.locationDescription}` : ""}
                      <span className="ml-1.5 uppercase opacity-60">· {inc.status}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
