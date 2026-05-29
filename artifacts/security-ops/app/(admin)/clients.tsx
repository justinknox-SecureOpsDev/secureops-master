import React, { useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, TextInput, Alert, Platform, Modal } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetClients, getGetClientsQueryKey, useCreateClient } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

export default function ClientsScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const topPad = useTopPad();

  const { data: clients, isLoading, error, refetch } = useGetClients({ query: { queryKey: getGetClientsQueryKey() } });
  const createClient = useCreateClient();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", contactName: "", contactEmail: "", contactPhone: "", billingAddress: "", paymentTermsDays: "30", notes: "" });

  const submit = async () => {
    if (!form.name) { Alert.alert("Missing", "Client name required."); return; }
    try {
      await createClient.mutateAsync({
        data: {
          name: form.name,
          contactName: form.contactName || undefined,
          contactEmail: form.contactEmail || undefined,
          contactPhone: form.contactPhone || undefined,
          billingAddress: form.billingAddress || undefined,
          paymentTermsDays: parseInt(form.paymentTermsDays) || 30,
          notes: form.notes || undefined,
        } as any,
      });
      queryClient.invalidateQueries({ queryKey: getGetClientsQueryKey() });
      setShowForm(false);
      setForm({ name: "", contactName: "", contactEmail: "", contactPhone: "", billingAddress: "", paymentTermsDays: "30", notes: "" });
    } catch (e: any) {
      Alert.alert("Failed", e?.response?.data?.message || e?.message || "Could not create client");
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">Clients</Text>
        <TouchableOpacity onPress={() => setShowForm(true)} style={[styles.addBtn, { backgroundColor: colors.primary }]} accessibilityRole="button" accessibilityLabel="New client">
          <Feather name="plus" size={16} color={colors.primaryForeground} />
          <Text style={{ color: colors.primaryForeground, fontWeight: "700", fontSize: 13 }}>New</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive }}>Failed to load</Text>
          <TouchableOpacity onPress={() => refetch()} accessibilityRole="button" accessibilityLabel="Retry loading clients"><Text style={{ color: colors.primary, marginTop: 8 }}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={clients ?? []}
          keyExtractor={(c: any) => c.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="briefcase" size={40} color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, marginTop: 12 }}>No clients yet — add your first one.</Text>
            </View>
          }
          renderItem={({ item }: { item: any }) => (
            <TouchableOpacity
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push(`/(admin)/clients/${item.id}` as any)}
              accessibilityRole="button"
              accessibilityLabel={`Client ${item.name}, Net ${item.paymentTermsDays} payment terms`}
              accessibilityHint="Opens client sites and details"
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: colors.foreground }]}>{item.name}</Text>
                {item.contactEmail && <Text style={[styles.sub, { color: colors.mutedForeground }]}>{item.contactEmail}</Text>}
                <View style={styles.metaRow}>
                  <View style={[styles.chip, { borderColor: colors.accent + "60", backgroundColor: colors.accent + "20" }]}>
                    <Feather name="clock" size={11} color={colors.accent} />
                    <Text style={[styles.chipText, { color: colors.accent }]}>Net {item.paymentTermsDays}</Text>
                  </View>
                </View>
              </View>
              <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          )}
        />
      )}

      <Modal visible={showForm} animationType="slide" transparent onRequestClose={() => setShowForm(false)}>
        <View style={[styles.modalBg]}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>New Client</Text>
            {([
              ["Client Name *", "name"],
              ["Contact Name", "contactName"],
              ["Contact Email", "contactEmail"],
              ["Contact Phone", "contactPhone"],
              ["Billing Address", "billingAddress"],
              ["Payment Terms (days)", "paymentTermsDays"],
              ["Notes", "notes"],
            ] as const).map(([label, key]) => (
              <View key={key} style={{ marginBottom: 10 }}>
                <Text style={[styles.modalLabel, { color: colors.mutedForeground }]}>{label}</Text>
                <TextInput
                  value={(form as any)[key]}
                  onChangeText={(v) => setForm((f) => ({ ...f, [key]: v }))}
                  style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                  placeholder=""
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType={key === "paymentTermsDays" ? "numeric" : key === "contactEmail" ? "email-address" : "default"}
                  autoCapitalize={key === "contactEmail" || key === "paymentTermsDays" ? "none" : "sentences"}
                  accessibilityLabel={label}
                />
              </View>
            ))}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
              <TouchableOpacity onPress={() => setShowForm(false)} style={[styles.btnSecondary, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Cancel">
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={submit} style={[styles.btnPrimary, { backgroundColor: colors.primary, opacity: createClient.isPending ? 0.6 : 1 }]} disabled={createClient.isPending} accessibilityRole="button" accessibilityLabel="Create client" accessibilityState={{ disabled: createClient.isPending, busy: createClient.isPending }}>
                {createClient.isPending ? <ActivityIndicator color={colors.primaryForeground} /> :
                  <Text style={{ color: colors.primaryForeground, fontWeight: "700" }}>Create</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 40, alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700", flex: 1 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  card: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 10, borderWidth: 1, gap: 10 },
  name: { fontSize: 15, fontWeight: "700" },
  sub: { fontSize: 12, marginTop: 2 },
  metaRow: { flexDirection: "row", gap: 6, marginTop: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, borderWidth: 1 },
  chipText: { fontSize: 11, fontWeight: "700" },
  modalBg: { flex: 1, backgroundColor: "#000a", justifyContent: "center", padding: 20 },
  modalCard: { borderRadius: 14, borderWidth: 1, padding: 18 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 14 },
  modalLabel: { fontSize: 11, fontWeight: "600", marginBottom: 4, letterSpacing: 0.5 },
  input: { height: 42, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 14 },
  btnSecondary: { flex: 1, padding: 12, borderRadius: 8, borderWidth: 1, alignItems: "center" },
  btnPrimary: { flex: 1, padding: 12, borderRadius: 8, alignItems: "center" },
});
