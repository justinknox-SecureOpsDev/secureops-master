import React, { useMemo } from "react";
import { View, Text, Platform, StyleSheet, ScrollView } from "react-native";
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

function buildLeafletHtml(points: Array<{ lat: number; lng: number; label: string; sub: string }>): string {
  // Coordinates are numbers (validated upstream); labels are user-controlled strings.
  // Pass them as JSON, then build popup DOM via createTextNode so admin-side XSS is impossible
  // even if an officer sets their name to "<img onerror=...>".
  const data = JSON.stringify(points);
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;padding:0;height:100%;background:#080c18}
.popup b{color:#080c18}.popup{font-family:-apple-system,system-ui,sans-serif;font-size:13px}</style></head>
<body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const pts = ${data};
function popupNode(label, sub) {
  const wrap = document.createElement('div');
  wrap.className = 'popup';
  const b = document.createElement('b');
  b.appendChild(document.createTextNode(String(label || '')));
  wrap.appendChild(b);
  wrap.appendChild(document.createElement('br'));
  wrap.appendChild(document.createTextNode(String(sub || '')));
  return wrap;
}
const map = L.map('m', { zoomControl: true });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap', maxZoom: 19,
}).addTo(map);
if (!pts.length) {
  map.setView([51.5074, -0.1278], 4);
} else {
  const group = L.featureGroup();
  pts.forEach(p => {
    const m = L.circleMarker([p.lat, p.lng], {
      radius: 10, color: '#c9a84c', fillColor: '#c9a84c', fillOpacity: 0.9, weight: 3,
    });
    m.bindPopup(popupNode(p.label, p.sub));
    m.addTo(group);
  });
  group.addTo(map);
  map.fitBounds(group.getBounds().pad(0.3), { maxZoom: 15 });
}
</script></body></html>`;
}

interface Props {
  officers: ActiveOfficer[];
  height?: number;
}

export default function LiveOfficerMap({ officers, height = 380 }: Props) {
  const colors = useColors();

  const points = useMemo(
    () => officers.map((o) => {
      const p = pickPos(o);
      if (!p) return null;
      return {
        lat: p.lat, lng: p.lng,
        label: `${o.firstName} ${o.lastName}`,
        sub: [o.shiftTitle, o.siteName].filter(Boolean).join(" — ") || "On duty",
      };
    }).filter(Boolean) as Array<{ lat: number; lng: number; label: string; sub: string }>,
    [officers],
  );

  const html = useMemo(() => buildLeafletHtml(points), [points]);

  if (Platform.OS === "web") {
    const Iframe: any = "iframe";
    return (
      <View style={[styles.wrap, { height, borderColor: colors.border, backgroundColor: "#080c18" }]}>
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
  // on iOS/Android even without react-native-webview installed.
  return (
    <View style={[styles.wrap, { height, borderColor: colors.border, backgroundColor: colors.card }]}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        <Text style={{ color: colors.mutedForeground, fontSize: 12, marginBottom: 4 }}>
          Open in browser for full map view
        </Text>
        {points.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 32 }}>
            <Feather name="map" size={36} color={colors.mutedForeground} />
            <Text style={{ color: colors.mutedForeground, marginTop: 8 }}>No officers on duty</Text>
          </View>
        ) : (
          points.map((p, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
              <Feather name="map-pin" size={16} color="#c9a84c" />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>{p.label}</Text>
                <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{p.sub}</Text>
                <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
                  {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
                </Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 12, borderWidth: 1, overflow: "hidden", marginHorizontal: 16 },
});
