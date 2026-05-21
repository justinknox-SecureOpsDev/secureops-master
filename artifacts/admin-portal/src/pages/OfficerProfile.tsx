import { useMemo, useState } from "react";
import { Radio } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useRoute, useLocation } from "wouter";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, User, Mail, Phone, ShieldCheck, AlertTriangle, Loader2,
  ExternalLink, MessageCircle, PhoneCall, Calendar, ShieldAlert, MapPin,
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
<style>html,body,#m{margin:0;padding:0;height:100%;background:#080c18}
.popup{font:13px -apple-system,system-ui,sans-serif}.popup b{color:#080c18}
.site-pin{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:5px;background:#080c18;color:#c9a84c;border:2px solid #c9a84c;font:bold 11px -apple-system,system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.35)}</style>
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
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'&copy; OpenStreetMap', maxZoom:19
}).addTo(map);
// Attach the group to the map BEFORE adding layers. L.circle uses a real
// metric radius and projects on add, so adding it to an off-map group
// throws "Cannot read properties of undefined (reading 'layerPointToLatLng')".
const group = L.featureGroup().addTo(map);
if (D.trail && D.trail.length >= 2) {
  L.polyline(D.trail.map(function(p){ return [p.lat, p.lng]; }), {
    color: '#3b82f6', weight: 3, opacity: 0.7,
  }).addTo(group);
}
if (D.site) {
  L.circle([D.site.lat, D.site.lng], {
    radius: D.radiusMeters, color:'#c9a84c', weight:1, opacity:0.5,
    fillColor:'#c9a84c', fillOpacity:0.08, interactive:false,
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
map.fitBounds(group.getBounds().pad(0.4), { maxZoom: 16 });
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

function startOfToday(): Date {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d;
}
function endOfToday(): Date {
  const d = new Date(); d.setHours(23, 59, 59, 999); return d;
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

  // Live location refreshes every 30s — same cadence as the Dispatch Live
  // Map — so dispatchers staying on this page during an active call see
  // fresh pings without manual refresh.
  const liveLocation = useQuery<LiveLocation>({
    queryKey: ["officer-live", id, trailWindow],
    queryFn: () => api<LiveLocation>(
      `/admin/officers/${encodeURIComponent(id)}/live?window=${trailWindow}`,
    ),
    enabled: !!id,
    refetchInterval: 30_000,
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
  }, [liveLocation.data, officerCoord, officer.data]);

  const recent5 = useMemo<Incident[]>(() => {
    const rows = recentIncidents.data ?? [];
    return [...rows]
      .sort((a, b) =>
        new Date(b.occurredAt ?? b.createdAt).getTime() -
        new Date(a.occurredAt ?? a.createdAt).getTime())
      .slice(0, 5);
  }, [recentIncidents.data]);

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
              </div>
              {openDm.error && (
                <div className="text-xs text-red-700">
                  Could not open chat: {openDm.error.message}
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
                  title="Officer live location"
                  srcDoc={mapHtml}
                  className="w-full h-64 border-0 border-t"
                  sandbox="allow-scripts"
                  data-testid="officer-live-map"
                />
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
