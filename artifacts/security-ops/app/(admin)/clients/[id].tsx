import React, { useState, useLayoutEffect } from "react";
import { useNavigation } from "expo-router";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, TextInput, Alert, Platform, Modal } from "react-native";
import { useColors } from "@/hooks/useColors";
import {
  useGetClient, getGetClientQueryKey,
  useGetSites, getGetSitesQueryKey,
  useCreateClientSite,
} from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

export default function ClientSitesScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const clientId = String(params.id);
  const queryClient = useQueryClient();
  const topPad = useTopPad();
  const navigation = useNavigation();
  useLayoutEffect(() => { (navigation as any).setOptions?.({ headerShown: false }); }, [navigation]);

  const { data: client } = useGetClient(clientId, { query: { queryKey: getGetClientQueryKey(clientId) } });
  const { data: sites, isLoading } = useGetSites({ clientId }, { query: { queryKey: getGetSitesQueryKey({ clientId }) } });
  const createSite = useCreateClientSite();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", contactName: "", contactPhone: "", notes: "" });

  const submit = async () => {
    if (!form.name) { Alert.alert("Missing", "Site name required."); return; }
    try {
      await createSite.mutateAsync({
        id: clientId,
        data: {
          name: form.name,
          address: form.address || undefined,
          contactName: form.contactName || undefined,
          contactPhone: form.contactPhone || undefined,
          notes: form.notes || undefined,
        } as any,
      });
      queryClient.invalidateQueries({ queryKey: getGetSitesQueryKey({ clientId }) });
      setShowForm(false);
      setForm({ name: "", address: "", contactName: "", contactPhone: "", notes: "" });
    } catch (e: any) {
      Alert.alert("Failed", e?.response?.data?.message || e?.message || "Could not create site");
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>{(client as any)?.name || "Client"}</Text>
          <Text style={[styles.sub, { color: colors.mutedForeground }]}>Sites · Net {(client as any)?.paymentTermsDays ?? 30} payment terms</Text>
        </View>
        <TouchableOpacity onPress={() => setShowForm(true)} style={[styles.addBtn, { backgroundColor: colors.primary }]}>
          <Feather name="plus" size={16} color={colors.primaryForeground} />
          <Text style={{ color: colors.primaryForeground, fontWeight: "700", fontSize: 13 }}>Site</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : (
        <FlatList
          data={sites ?? []}
          keyExtractor={(s: any) => s.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="map-pin" size={40} color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, marginTop: 12 }}>No sites yet for this client.</Text>
            </View>
          }
          renderItem={({ item }: { item: any }) => (
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="map-pin" size={20} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: colors.foreground }]}>{item.name}</Text>
                {item.address && <Text style={[styles.sub, { color: colors.mutedForeground }]}>{item.address}</Text>}
              </View>
            </View>
          )}
        />
      )}

      <Modal visible={showForm} animationType="slide" transparent onRequestClose={() => setShowForm(false)}>
        <View style={styles.modalBg}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>New Site</Text>
            {([
              ["Site Name *", "name"],
              ["Address", "address"],
              ["Contact Name", "contactName"],
              ["Contact Phone", "contactPhone"],
              ["Notes", "notes"],
            ] as const).map(([label, key]) => (
              <View key={key} style={{ marginBottom: 10 }}>
                <Text style={[styles.modalLabel, { color: colors.mutedForeground }]}>{label}</Text>
                <TextInput
                  value={(form as any)[key]}
                  onChangeText={(v) => setForm((f) => ({ ...f, [key]: v }))}
                  style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                  placeholderTextColor={colors.mutedForeground}
                />
              </View>
            ))}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
              <TouchableOpacity onPress={() => setShowForm(false)} style={[styles.btnSecondary, { borderColor: colors.border }]}>
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={submit} style={[styles.btnPrimary, { backgroundColor: colors.primary, opacity: createSite.isPending ? 0.6 : 1 }]} disabled={createSite.isPending}>
                {createSite.isPending ? <ActivityIndicator color={colors.primaryForeground} /> :
                  <Text style={{ color: colors.primaryForeground, fontWeight: "700" }}>Create</Text>}
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
  pageTitle: { fontSize: 18, fontWeight: "700" },
  sub: { fontSize: 11, marginTop: 2 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  card: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 10, borderWidth: 1, gap: 12 },
  name: { fontSize: 14, fontWeight: "700" },
  modalBg: { flex: 1, backgroundColor: "#000a", justifyContent: "center", padding: 20 },
  modalCard: { borderRadius: 14, borderWidth: 1, padding: 18 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 14 },
  modalLabel: { fontSize: 11, fontWeight: "600", marginBottom: 4, letterSpacing: 0.5 },
  input: { height: 42, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 14 },
  btnSecondary: { flex: 1, padding: 12, borderRadius: 8, borderWidth: 1, alignItems: "center" },
  btnPrimary: { flex: 1, padding: 12, borderRadius: 8, alignItems: "center" },
});
