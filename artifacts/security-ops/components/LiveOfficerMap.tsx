import React, { useEffect, useMemo } from "react";
import { View, Text, Platform, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

export interface ActiveOfficer {
  userId: string;
  firstName: string;
  lastName: string;
  lastLat?: string | null;
  lastLng?: string | null;
  lastLocationAt?: string | null;
  clockInLat?: string | null;
  clockInLng?: string | null;
  shiftTitle?: string | null;
  siteName?: string | null;
  siteAddress?: string | null;
}

function pickPos(o: ActiveOfficer): { lat: number; lng: number } | null {
  const la = o.lastLat ?? o.clockInLat;
  const ln = o.lastLng ?? o.clockInLng;
  if (la == null || ln == null) return null;
  const lat = parseFloat(la);
  const lng = parseFloat(ln);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { lat, lng };
}

function buildLeafletHtml(
  points: Array<{ lat: number; lng: number; label: string; sub: string; userId: string }>,
  focusUserId?: string,
  focusKey?: string,
): string {
  // Coordinates are numbers (validated upstream); labels and userIds are user-controlled
  // strings. Pass them as JSON, then build popup DOM via createTextNode + a button whose
  // click postMessages the userId to the parent — admin-side XSS is impossible even if
  // an officer sets their name to "<img onerror=...>".
  const data = JSON.stringify(points);
  const focus = JSON.stringify(focusUserId ?? null);
  // focusKey is embedded as an HTML comment so that repeated alert taps for the
  // same officer change the srcDoc string and force the iframe to re-render +
  // re-center, even though the points payload is identical.
  return `<!doctype html><html><head><meta charset="utf-8"/>
<!-- focusKey:${String(focusKey ?? "")} -->
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;padding:0;height:100%;background:#0c0a08}
.popup b{color:#0c0a08}.popup{font-family:-apple-system,system-ui,sans-serif;font-size:13px}
.popup button{margin-top:6px;background:#0c0a08;color:#c9a04a;border:1px solid #c9a04a;
border-radius:4px;padding:4px 8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.popup button:hover{background:#c9a04a;color:#0c0a08}</style></head>
<body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const pts = ${data};
function popupNode(label, sub, userId) {
  const wrap = document.createElement('div');
  wrap.className = 'popup';
  const b = document.createElement('b');
  b.appendChild(document.createTextNode(String(label || '')));
  wrap.appendChild(b);
  wrap.appendChild(document.createElement('br'));
  wrap.appendChild(document.createTextNode(String(sub || '')));
  if (userId) {
    wrap.appendChild(document.createElement('br'));
    const btn = document.createElement('button');
    btn.appendChild(document.createTextNode('View profile'));
    btn.addEventListener('click', function () {
      try { parent.postMessage({ type: 'wcsg:openOfficer', userId: String(userId) }, '*'); } catch (e) {}
    });
    wrap.appendChild(btn);
  }
  return wrap;
}
const map = L.map('m', { zoomControl: true });
// Leaflet needs a view (center + zoom) BEFORE any layer that projects on add.
// Without this, adding circles/markers can throw "Cannot read properties of
// undefined (reading 'layerPointToLatLng')". fitBounds below replaces the view
// when we have points; the no-points branch just keeps this default.
map.setView(pts.length ? [pts[0].lat, pts[0].lng] : [39.8283, -98.5795], pts.length ? 12 : 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap', maxZoom: 19,
}).addTo(map);
// Legend — bottom-left, built entirely via DOM API (no innerHTML) to stay
// consistent with the XSS-safe pattern used for popups above.
const LegendControl = L.Control.extend({
  onAdd: function() {
    const div = document.createElement('div');
    div.style.cssText = 'background:rgba(12,10,8,0.88);border:1px solid #c9a04a;border-radius:6px;padding:8px 12px;font-family:-apple-system,system-ui,sans-serif;font-size:12px;color:#f0e4c0;display:flex;flex-direction:column;gap:6px;pointer-events:none;line-height:1;';
    // Officer row — green circle
    const officerRow = document.createElement('div');
    officerRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const officerDot = document.createElement('span');
    officerDot.style.cssText = 'display:inline-block;width:12px;height:12px;border-radius:50%;background:#22c55e;border:2px solid #16a34a;flex-shrink:0;';
    const officerLabel = document.createElement('span');
    officerLabel.appendChild(document.createTextNode('Officer'));
    officerRow.appendChild(officerDot);
    officerRow.appendChild(officerLabel);
    // Site row — gold diamond (rotated square)
    const siteRow = document.createElement('div');
    siteRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const siteDiamond = document.createElement('span');
    siteDiamond.style.cssText = 'display:inline-block;width:10px;height:10px;background:#c9a04a;transform:rotate(45deg);flex-shrink:0;border:1px solid #f0e4c0;';
    const siteLabel = document.createElement('span');
    siteLabel.appendChild(document.createTextNode('Site'));
    siteRow.appendChild(siteDiamond);
    siteRow.appendChild(siteLabel);
    div.appendChild(officerRow);
    div.appendChild(siteRow);
    return div;
  },
});
new LegendControl({ position: 'bottomleft' }).addTo(map);
const focusId = ${focus};
if (pts.length) {
  const group = L.featureGroup().addTo(map);
  const markers = {};
  pts.forEach(p => {
    const isFocus = focusId && String(p.userId) === String(focusId);
    const m = L.circleMarker([p.lat, p.lng], {
      radius: isFocus ? 14 : 10,
      color: isFocus ? '#f0e4c0' : '#16a34a',
      fillColor: '#22c55e', fillOpacity: 0.9, weight: isFocus ? 5 : 3,
    });
    m.bindPopup(popupNode(p.label, p.sub, p.userId));
    m.addTo(group);
    markers[String(p.userId)] = { marker: m, lat: p.lat, lng: p.lng };
  });
  // Manual bounds — avoid group.getBounds() / Circle.getBounds() paths that
  // have intermittently hit "Cannot read properties of undefined" in
  // sandboxed iframes even when layers are correctly added.
  const _bb = L.latLngBounds([]);
  pts.forEach(p => _bb.extend([p.lat, p.lng]));
  if (_bb.isValid()) map.fitBounds(_bb.pad(0.3), { maxZoom: 15 });
  // When an alert deep-links to a specific officer, recenter on them and open
  // their popup so the admin sees exactly who triggered the alert.
  const focused = focusId ? markers[String(focusId)] : null;
  if (focused) {
    map.setView([focused.lat, focused.lng], 15);
    try { focused.marker.openPopup(); } catch (e) {}
  }
}
</script></body></html>`;
}

interface Props {
  officers: ActiveOfficer[];
  height?: number;
  onSelectOfficer?: (userId: string) => void;
  focusUserId?: string | null;
  focusKey?: string | null;
}

export default function LiveOfficerMap({ officers, height = 380, onSelectOfficer, focusUserId, focusKey }: Props) {
  const colors = useColors();

  const points = useMemo(
    () => officers.map((o) => {
      const p = pickPos(o);
      if (!p) return null;
      return {
        lat: p.lat, lng: p.lng,
        userId: o.userId,
        label: `${o.firstName} ${o.lastName}`,
        sub: [o.shiftTitle, o.siteName].filter(Boolean).join(" — ") || "On duty",
      };
    }).filter(Boolean) as Array<{ lat: number; lng: number; label: string; sub: string; userId: string }>,
    [officers],
  );

  const html = useMemo(
    () => buildLeafletHtml(points, focusUserId ?? undefined, focusKey ?? undefined),
    [points, focusUserId, focusKey],
  );

  // Listen for "View profile" clicks from inside the leaflet iframe (web only).
  useEffect(() => {
    if (Platform.OS !== "web" || !onSelectOfficer) return;
    const handler = (ev: MessageEvent) => {
      const data = ev.data;
      if (data && typeof data === "object" && (data as any).type === "wcsg:openOfficer") {
        const uid = (data as any).userId;
        if (typeof uid === "string" && uid.length > 0) onSelectOfficer(uid);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onSelectOfficer]);

  if (Platform.OS === "web") {
    const Iframe: any = "iframe";
    return (
      <View style={[styles.wrap, { height, borderColor: colors.border, backgroundColor: "#0c0a08" }]}>
        <Iframe
          srcDoc={html}
          sandbox="allow-scripts"
          style={{ width: "100%", height: "100%", border: 0, display: "block" }}
          title="Live officer map"
        />
      </View>
    );
  }

  // Native fallback: clean text list with coordinates so the feature still works
  // on iOS/Android even without react-native-webview installed. Each row taps
  // through to the officer profile when onSelectOfficer is supplied.
  const officersWithPos = officers
    .map((o) => ({ officer: o, pos: pickPos(o) }))
    .filter((x) => x.pos !== null) as Array<{ officer: ActiveOfficer; pos: { lat: number; lng: number } }>;

  return (
    <View style={[styles.wrap, { height, borderColor: colors.border, backgroundColor: colors.card }]}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        <Text style={{ color: colors.mutedForeground, fontSize: 12, marginBottom: 4 }}>
          Open in browser for full map view
        </Text>
        {officersWithPos.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 32 }}>
            <Feather name="map" size={36} color={colors.mutedForeground} />
            <Text style={{ color: colors.mutedForeground, marginTop: 8 }}>No officers on duty</Text>
          </View>
        ) : (
          officersWithPos.map(({ officer, pos }) => {
            const label = `${officer.firstName} ${officer.lastName}`;
            const sub = [officer.shiftTitle, officer.siteName].filter(Boolean).join(" — ") || "On duty";
            const isFocus = !!focusUserId && officer.userId === focusUserId;
            const rowStyle = {
              flexDirection: "row" as const, gap: 10, alignItems: "flex-start" as const,
              ...(isFocus ? { borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.primary + "22", borderRadius: 8, padding: 8 } : null),
            };
            const inner = (
              <>
                <Feather name="map-pin" size={16} color="#c9a04a" />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.foreground, fontWeight: "600" }}>{label}</Text>
                  <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{sub}</Text>
                  <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
                    {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}
                  </Text>
                </View>
                {onSelectOfficer && <Feather name="chevron-right" size={18} color={colors.mutedForeground} />}
              </>
            );
            if (onSelectOfficer) {
              return (
                <TouchableOpacity
                  key={officer.userId}
                  onPress={() => onSelectOfficer(officer.userId)}
                  accessibilityRole="button"
                  accessibilityLabel={`View profile for ${label}`}
                  style={rowStyle}
                >
                  {inner}
                </TouchableOpacity>
              );
            }
            return (
              <View key={officer.userId} style={rowStyle}>
                {inner}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 12, borderWidth: 1, overflow: "hidden", marginHorizontal: 16 },
});
