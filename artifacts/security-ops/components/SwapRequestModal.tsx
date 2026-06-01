import React, { useEffect, useMemo, useState } from "react";
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/utils/api";
import { notify } from "@/utils/confirm";
import { Feather } from "@expo/vector-icons";

type Officer = { id: string; firstName: string; lastName: string };

export function SwapRequestModal({
  visible,
  onClose,
  onSubmitted,
  assignmentId,
  shiftTitle,
  myUserId,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  assignmentId: string;
  shiftTitle: string;
  myUserId: string;
}) {
  const colors = useColors();
  const [officers, setOfficers] = useState<Officer[] | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setPickedId(null); setReason(""); setSearch(""); setOfficers(null);
    apiRequest(`/me/swap-targets/${assignmentId}`)
      .then((list: Officer[]) => setOfficers(Array.isArray(list) ? list : []))
      .catch(() => setOfficers([]));
  }, [visible, assignmentId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return officers ?? [];
    return (officers ?? []).filter((o) =>
      `${o.firstName} ${o.lastName}`.toLowerCase().includes(q),
    );
  }, [officers, search]);

  const submit = async () => {
    if (!pickedId) {
      notify("Pick an officer", "Choose who you want to take this shift.");
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("/shifts/swap-requests", {
        method: "POST",
        body: JSON.stringify({ assignmentId, targetUserId: pickedId, reason: reason || undefined }),
      });
      notify("Swap requested", "We've notified the officer. You'll see updates in Shift Swaps.");
      onSubmitted();
      onClose();
    } catch (e: any) {
      notify("Couldn't request swap", e?.message ?? "Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.head}>
            <Text style={[styles.title, { color: colors.foreground }]} accessibilityRole="header">Request shift swap</Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close swap request">
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>{shiftTitle}</Text>

          <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
            <Feather name="search" size={14} color={colors.mutedForeground} />
            <TextInput
              style={[styles.searchInput, { color: colors.foreground }]}
              placeholder="Search officers"
              placeholderTextColor={colors.mutedForeground}
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              accessibilityLabel="Search officers"
              accessibilityHint="Filter the officer list by name"
            />
          </View>

          {officers === null ? (
            <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(o) => o.id}
              style={{ maxHeight: 220 }}
              keyboardShouldPersistTaps="handled"
              ItemSeparatorComponent={() => <View style={{ height: 4 }} />}
              ListEmptyComponent={
                <Text style={{ color: colors.mutedForeground, padding: 14, textAlign: "center" }}>
                  No officers available.
                </Text>
              }
              renderItem={({ item }) => {
                const picked = item.id === pickedId;
                return (
                  <TouchableOpacity
                    onPress={() => setPickedId(item.id)}
                    accessibilityRole="radio"
                    accessibilityLabel={`${item.firstName} ${item.lastName}`}
                    accessibilityState={{ selected: picked, checked: picked }}
                    style={[
                      styles.row,
                      {
                        borderColor: picked ? colors.primary : colors.border,
                        backgroundColor: picked ? colors.primary + "20" : "transparent",
                      },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 14 }}>
                        {item.firstName} {item.lastName}
                      </Text>
                    </View>
                    {picked && <Feather name="check" size={16} color={colors.primary} />}
                  </TouchableOpacity>
                );
              }}
            />
          )}

          <TextInput
            style={[styles.reasonInput, { borderColor: colors.border, backgroundColor: colors.secondary, color: colors.foreground }]}
            placeholder="Reason (optional)"
            placeholderTextColor={colors.mutedForeground}
            value={reason}
            onChangeText={setReason}
            multiline
            maxLength={500}
            accessibilityLabel="Reason"
            accessibilityHint="Optional. Why you want to swap this shift"
          />

          <TouchableOpacity
            style={[styles.submit, { backgroundColor: colors.primary, opacity: submitting || !pickedId ? 0.6 : 1 }]}
            disabled={submitting || !pickedId}
            onPress={submit}
            accessibilityRole="button"
            accessibilityLabel="Send swap request"
            accessibilityState={{ disabled: submitting || !pickedId, busy: submitting }}
          >
            {submitting ? <ActivityIndicator color={colors.primaryForeground} /> : (
              <Text style={[styles.submitText, { color: colors.primaryForeground }]}>Send request</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: { padding: 18, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, gap: 12 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 17, fontWeight: "700" },
  subtitle: { fontSize: 12 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 8, height: 40, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12 },
  searchInput: { flex: 1, fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 8, borderWidth: 1 },
  reasonInput: { borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 13, minHeight: 60, textAlignVertical: "top" },
  submit: { paddingVertical: 12, borderRadius: 8, alignItems: "center" },
  submitText: { fontWeight: "700", fontSize: 14 },
  center: { padding: 30, alignItems: "center" },
});
