import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, TextInput, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/utils/api";
import { useAuth } from "@/contexts/AuthContext";
import { formatDistanceToNow } from "date-fns";

interface ChatRoom {
  id: string;
  name: string;
  type: string;
  messageCount: number;
  lastMessage?: { content: string; createdAt: string; userName: string } | null;
}

interface Props {
  onSelectRoom: (id: string, name: string) => void;
}

export default function ChatRoomsList({ onSelectRoom }: Props) {
  const colors = useColors();
  const { user } = useAuth();
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newRoom, setNewRoom] = useState("");
  const [creating, setCreating] = useState(false);
  const isAdmin = user?.role === "admin";

  const fetchRooms = useCallback(async () => {
    try {
      const data = await apiRequest("/chat/rooms");
      setRooms(data);
    } catch (e) {
      console.error("Failed to load rooms", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchRooms(); }, [fetchRooms]);

  const createRoom = async () => {
    if (!newRoom.trim()) return;
    setCreating(true);
    try {
      await apiRequest("/chat/rooms", { method: "POST", body: JSON.stringify({ name: newRoom.trim(), type: "general" }) });
      setNewRoom("");
      fetchRooms();
    } finally {
      setCreating(false);
    }
  };

  const s = styles(colors);

  const roomIcon = (type: string) => {
    if (type === "shift") return "briefcase";
    if (type === "direct") return "user";
    return "hash";
  };

  if (loading) {
    return (
      <View style={[s.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]} edges={["bottom"]}>
      <View style={s.header}>
        <Text style={[s.title, { color: colors.foreground }]}>Team Chat</Text>
        <Text style={[s.subtitle, { color: colors.mutedForeground }]}>
          Williams Council Security Group
        </Text>
      </View>

      {isAdmin && (
        <View style={[s.newRoomRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <TextInput
            style={[s.input, { color: colors.foreground }]}
            placeholder="New channel name..."
            placeholderTextColor={colors.mutedForeground}
            value={newRoom}
            onChangeText={setNewRoom}
            onSubmitEditing={createRoom}
          />
          <TouchableOpacity onPress={createRoom} disabled={creating} style={s.addBtn}>
            {creating ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="plus" size={20} color={colors.primary} />}
          </TouchableOpacity>
        </View>
      )}

      <FlatList
        data={rooms}
        keyExtractor={(r) => r.id}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchRooms(); }} tintColor={colors.primary} />}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[s.roomCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => onSelectRoom(item.id, item.name)}
            activeOpacity={0.75}
          >
            <View style={[s.roomIcon, { backgroundColor: colors.primary + "22" }]}>
              <Feather name={roomIcon(item.type) as any} size={18} color={colors.primary} />
            </View>
            <View style={s.roomInfo}>
              <View style={s.roomTopRow}>
                <Text style={[s.roomName, { color: colors.foreground }]}>#{item.name}</Text>
                {item.lastMessage && (
                  <Text style={[s.time, { color: colors.mutedForeground }]}>
                    {formatDistanceToNow(new Date(item.lastMessage.createdAt), { addSuffix: true })}
                  </Text>
                )}
              </View>
              {item.lastMessage ? (
                <Text style={[s.lastMsg, { color: colors.mutedForeground }]} numberOfLines={1}>
                  <Text style={{ fontWeight: "600" }}>{item.lastMessage.userName}: </Text>
                  {item.lastMessage.content}
                </Text>
              ) : (
                <Text style={[s.lastMsg, { color: colors.mutedForeground }]}>No messages yet</Text>
              )}
            </View>
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
        ListEmptyComponent={() => (
          <View style={s.center}>
            <Feather name="message-circle" size={48} color={colors.mutedForeground} />
            <Text style={[s.emptyText, { color: colors.mutedForeground }]}>No channels yet</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  title: { fontSize: 24, fontWeight: "700" },
  subtitle: { fontSize: 13, marginTop: 2 },
  newRoomRow: {
    flexDirection: "row", alignItems: "center", marginHorizontal: 16, marginBottom: 12,
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12,
  },
  input: { flex: 1, height: 44, fontSize: 15 },
  addBtn: { paddingLeft: 8 },
  list: { paddingHorizontal: 16, gap: 8, paddingBottom: 100 },
  roomCard: {
    flexDirection: "row", alignItems: "center", padding: 14,
    borderRadius: 12, borderWidth: 1, gap: 12,
  },
  roomIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  roomInfo: { flex: 1 },
  roomTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  roomName: { fontSize: 15, fontWeight: "600" },
  time: { fontSize: 12 },
  lastMsg: { fontSize: 13, marginTop: 2 },
  emptyText: { marginTop: 12, fontSize: 16 },
});
