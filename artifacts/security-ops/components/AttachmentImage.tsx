import React, { useEffect, useState } from "react";
import { Image, View, ActivityIndicator, StyleSheet, TouchableOpacity, type ImageStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { apiRequest } from "@/utils/api";
import { useColors } from "@/hooks/useColors";

type Props = {
  path: string;
  size?: number;
  style?: ImageStyle;
  /** "me" → /me/storage/sign (employees), "admin" → /admin/storage/sign */
  scope?: "me" | "admin";
  onPress?: (signedUrl: string) => void;
};

export function AttachmentImage({ path, size = 80, style, scope = "me", onPress }: Props) {
  const colors = useColors();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    (async () => {
      try {
        const endpoint = scope === "admin" ? "/admin/storage/sign" : "/me/storage/sign";
        const res = (await apiRequest(`${endpoint}?path=${encodeURIComponent(path)}`)) as { url: string };
        if (!cancelled) setUrl(res.url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [path, scope]);

  const dim = { width: size, height: size };
  const inner = url ? (
    <Image source={{ uri: url }} style={[dim, styles.img, style]} resizeMode="cover" />
  ) : failed ? (
    <View style={[dim, styles.fallback, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <Feather name="image" size={Math.round(size / 3)} color={colors.mutedForeground} />
    </View>
  ) : (
    <View style={[dim, styles.fallback, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <ActivityIndicator size="small" color={colors.mutedForeground} />
    </View>
  );

  if (onPress && url) {
    return <TouchableOpacity onPress={() => onPress(url)} activeOpacity={0.8}>{inner}</TouchableOpacity>;
  }
  return inner;
}

const styles = StyleSheet.create({
  img: { borderRadius: 6 },
  fallback: { borderRadius: 6, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
