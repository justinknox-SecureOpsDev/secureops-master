/**
 * Pure, React-Native-free helpers for the live officer map.
 *
 * Keeping these in a separate module means Vitest can import and test them
 * without pulling in `react-native` (which uses `import typeof`, a Flow
 * extension that Rollup/Vitest cannot parse).
 *
 * `LiveOfficerMap.tsx` re-exports these for external consumers.
 */

export interface SitePoint {
  lat: number;
  lng: number;
  name: string;
  siteChannelId?: string | null;
}

export interface ActiveOfficerCoords {
  userId: string;
  siteLat?: string | null;
  siteLng?: string | null;
  siteName?: string | null;
  siteChannelId?: string | null;
}

/**
 * Derive unique geocoded site markers from the active-officer list.
 * Each geocoded site appears once even if multiple officers are on duty there.
 * Officers without a geocoded site (siteLat/siteLng null) are skipped.
 */
export function deriveSitePoints(officers: ActiveOfficerCoords[]): SitePoint[] {
  const seen = new Set<string>();
  const out: SitePoint[] = [];
  for (const o of officers) {
    if (!o.siteLat || !o.siteLng || !o.siteName) continue;
    const lat = parseFloat(o.siteLat);
    const lng = parseFloat(o.siteLng);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lat, lng, name: o.siteName, siteChannelId: o.siteChannelId ?? null });
  }
  return out;
}

/**
 * Pure handler for postMessages sent by the Leaflet iframe.
 * Extracted so it can be unit-tested without a browser / React renderer.
 */
export function handleMapMessage(
  data: unknown,
  callbacks: {
    onSelectOfficer?: (userId: string) => void;
    onOpenSiteRadio?: (channelId: string, siteName: string) => void;
    onOfficerLeft?: (userId: string) => void;
    onOfficerJoined?: (userId: string) => void;
  },
): void {
  if (!data || typeof data !== "object") return;
  const msg = data as Record<string, unknown>;
  if (msg.type === "wcsg:openOfficer") {
    const uid = msg.userId;
    if (typeof uid === "string" && uid.length > 0) callbacks.onSelectOfficer?.(uid);
  } else if (msg.type === "liveOps:officerLeft") {
    // Server-pushed WS event: an officer just clocked out. Routed through
    // this same pure handler so the live-map screen can remove the marker
    // immediately without waiting for the next active-officers poll.
    const uid = msg.userId;
    if (typeof uid === "string" && uid.length > 0) callbacks.onOfficerLeft?.(uid);
  } else if (msg.type === "liveOps:officerJoined") {
    // Server-pushed WS event: an officer just clocked in. The screen refetches
    // the active-officers query (server is the source of truth for the row)
    // so the new marker appears without waiting for the next 30s poll.
    const uid = msg.userId;
    if (typeof uid === "string" && uid.length > 0) callbacks.onOfficerJoined?.(uid);
  } else if (msg.type === "wcsg:openSiteRadio") {
    const channelId = msg.channelId;
    const siteName = msg.siteName;
    if (typeof channelId === "string" && channelId.length > 0) {
      callbacks.onOpenSiteRadio?.(channelId, typeof siteName === "string" ? siteName : "");
    }
  }
}

/**
 * Build the full Leaflet HTML document for the iframe.
 *
 * Officer points render as gold circle markers; site points render as gold
 * diamond markers (rotated squares via CSS on a DivIcon).  The diamond popup
 * includes a "Radio" button only when `siteChannelId` is non-null.
 *
 * All user-supplied strings are passed through JSON.stringify and decoded via
 * createTextNode inside the iframe — there is no innerHTML concatenation, so
 * XSS is not possible even if a name contains `<script>` tags.
 *
 * Exported for unit testing.
 */
export function buildLeafletHtml(
  points: Array<{ lat: number; lng: number; label: string; sub: string; userId: string }>,
  sites: SitePoint[],
  focusUserId?: string,
  focusKey?: string,
): string {
  const data = JSON.stringify(points);
  const sitesData = JSON.stringify(sites);
  const focus = JSON.stringify(focusUserId ?? null);
  return `<!doctype html><html><head><meta charset="utf-8"/>
<!-- focusKey:${String(focusKey ?? "")} -->
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;padding:0;height:100%;background:#0c0a08}
.leaflet-div-icon{background:transparent;border:none}
.site-diamond{width:14px;height:14px;transform:rotate(45deg);background:#c9a04a;border:2px solid #f0e4c0;box-sizing:border-box}
.popup b{color:#0c0a08}.popup{font-family:-apple-system,system-ui,sans-serif;font-size:13px}
.popup button{margin-top:6px;background:#0c0a08;color:#c9a04a;border:1px solid #c9a04a;
border-radius:4px;padding:4px 8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:block}
.popup button:hover{background:#c9a04a;color:#0c0a08}</style></head>
<body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const pts = ${data};
const sitePts = ${sitesData};
function officerPopupNode(label, sub, userId) {
  const wrap = document.createElement('div');
  wrap.className = 'popup';
  const b = document.createElement('b');
  b.appendChild(document.createTextNode(String(label || '')));
  wrap.appendChild(b);
  wrap.appendChild(document.createElement('br'));
  wrap.appendChild(document.createTextNode(String(sub || '')));
  if (userId) {
    const btn = document.createElement('button');
    btn.appendChild(document.createTextNode('View profile'));
    btn.addEventListener('click', function () {
      try { parent.postMessage({ type: 'wcsg:openOfficer', userId: String(userId) }, '*'); } catch (e) {}
    });
    wrap.appendChild(btn);
  }
  return wrap;
}
function sitePopupNode(name, siteChannelId) {
  const wrap = document.createElement('div');
  wrap.className = 'popup';
  const b = document.createElement('b');
  b.appendChild(document.createTextNode(String(name || '')));
  wrap.appendChild(b);
  if (siteChannelId) {
    const btn = document.createElement('button');
    btn.appendChild(document.createTextNode('Radio'));
    btn.addEventListener('click', function () {
      try { parent.postMessage({ type: 'wcsg:openSiteRadio', channelId: String(siteChannelId), siteName: String(name || '') }, '*'); } catch (e) {}
    });
    wrap.appendChild(btn);
  }
  return wrap;
}
const map = L.map('m', { zoomControl: true });
map.setView(pts.length ? [pts[0].lat, pts[0].lng] : (sitePts.length ? [sitePts[0].lat, sitePts[0].lng] : [39.8283, -98.5795]), (pts.length || sitePts.length) ? 12 : 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap', maxZoom: 19,
}).addTo(map);
const focusId = ${focus};
const group = L.featureGroup().addTo(map);
const markers = {};
pts.forEach(p => {
  const isFocus = focusId && String(p.userId) === String(focusId);
  const m = L.circleMarker([p.lat, p.lng], {
    radius: isFocus ? 14 : 10,
    color: isFocus ? '#f0e4c0' : '#c9a04a',
    fillColor: '#c9a04a', fillOpacity: 0.9, weight: isFocus ? 5 : 3,
  });
  m.bindPopup(officerPopupNode(p.label, p.sub, p.userId));
  m.addTo(group);
  markers[String(p.userId)] = { marker: m, lat: p.lat, lng: p.lng };
});
sitePts.forEach(s => {
  const icon = L.divIcon({
    className: 'leaflet-div-icon',
    html: '<div class="site-diamond"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    popupAnchor: [0, -10],
  });
  const m = L.marker([s.lat, s.lng], { icon });
  m.bindPopup(sitePopupNode(s.name, s.siteChannelId || null));
  m.addTo(group);
});
if (pts.length || sitePts.length) {
  const _bb = L.latLngBounds([]);
  pts.forEach(p => _bb.extend([p.lat, p.lng]));
  sitePts.forEach(s => _bb.extend([s.lat, s.lng]));
  if (_bb.isValid()) map.fitBounds(_bb.pad(0.3), { maxZoom: 15 });
  const focused = focusId ? markers[String(focusId)] : null;
  if (focused) {
    map.setView([focused.lat, focused.lng], 15);
    try { focused.marker.openPopup(); } catch (e) {}
  }
}
</script></body></html>`;
}
