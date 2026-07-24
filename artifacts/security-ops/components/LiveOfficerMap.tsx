import React, { useEffect, useMemo } from "react";
import { View, Text, Platform, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import {
  buildLeafletHtml,
  deriveSitePoints,
  handleMapMessage,
  type SitePoint,
} from "./liveOfficerMapHelpers";

export type { SitePoint };
export { buildLeafletHtml, deriveSitePoints, handleMapMessage };

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
  siteId?: string | null;
  siteName?: string | null;
  siteAddress?: string | null;
  siteLat?: string | null;
  siteLng?: string | null;
  siteChannelId?: string | null;
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

interface Props {
  officers: ActiveOfficer[];
  height?: number;
  onSelectOfficer?: (userId: string) => void;
  onOpenSiteRadio?: (channelId: string, siteName: string) => void;
  focusUserId?: string | null;
  focusKey?: string | null;
}

export default function LiveOfficerMap({ officers, height = 380, onSelectOfficer, onOpenSiteRadio, focusUserId, focusKey }: Props) {
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

  const sites = useMemo(() => deriveSitePoints(officers), [officers]);

  const html = useMemo(
    () => buildLeafletHtml(points, sites, focusUserId ?? undefined, focusKey ?? undefined),
    [points, sites, focusUserId, focusKey],
  );

  // Listen for postMessages from inside the leaflet iframe (web only).
  // Handles both "View profile" officer clicks and "Open Radio" site clicks.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!onSelectOfficer && !onOpenSiteRadio) return;
    const handler = (ev: MessageEvent) => {
      handleMapMessage(ev.data, { onSelectOfficer, onOpenSiteRadio });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onSelectOfficer, onOpenSiteRadio]);

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
