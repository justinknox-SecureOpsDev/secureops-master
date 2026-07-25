import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, TextInput, Modal, Platform, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useBrand } from "@/hooks/useFeatures";
import { apiRequest } from "@/utils/api";
import { useAuth } from "@/contexts/AuthContext";
import { useChat } from "@/contexts/ChatContext";
import { formatDistanceToNow } from "date-fns";

interface ChatRoom {
  id: string;
  name: string;
  type: string;
  siteId?: string | null;
  pinned: boolean;
  messageCount: number;
  otherUserId?: string | null;
  otherUserName?: string | null;
  lastMessage?: { content: string; createdAt: string; userName: string } | null;
}

interface ChatUser {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
}

interface Props {
  onSelectRoom: (id: string, name: string) => void;
  /**
   * Bumped by the parent each time this pane becomes visible again after being
   * hidden behind a display toggle (see app/(employee)/chat.tsx). The list is
   * permanently mounted there, so this is the only signal that the user
   * switched back and the room list may be stale. Defaults to 0 so standalone
   * usages keep working unchanged.
   */
  refreshEpoch?: number;
}

export default function ChatRoomsList({ onSelectRoom, refreshEpoch = 0 }: Props) {
  const colors = useColors();
  const brand = useBrand();
  const { user } = useAuth();
  const { unreadByRoom, markRoomRead, refreshUnread } = useChat();
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newRoom, setNewRoom] = useState("");
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<"channels" | "direct">("channels");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const isAdmin = user?.role === "admin";

  const handleSelectRoom = useCallback((id: string, name: string) => {
    void markRoomRead(id);
    onSelectRoom(id, name);
  }, [markRoomRead, onSelectRoom]);

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

  useEffect(() => { fetchRooms(); void refreshUnread(); }, [fetchRooms, refreshUnread]);

  // Silent refetch when the parent flips back to the Messages sub-tab.
  // Skip the mount value (0) — the mount effect above already fetched.
  useEffect(() => {
    if (refreshEpoch === 0) return;
    void fetchRooms();
    void refreshUnread();
  }, [refreshEpoch, fetchRooms, refreshUnread]);

  const createRoom = async () => {
    if (!newRoom.trim()) return;
    setCreating(true);
    try {
      await apiRequest("/chat/rooms", { method: "POST", body: JSON.stringify({ name: newRoom.trim(), type: "announcements" }) });
      setNewRoom("");
      fetchRooms();
    } finally {
      setCreating(false);
    }
  };

  const openPicker = async () => {
    setPickerOpen(true);
    setUsersLoading(true);
    try {
      const data = await apiRequest("/chat/users");
      setUsers(data);
    } finally {
      setUsersLoading(false);
    }
  };

  const startDirect = async (otherUserId: string, otherName: string) => {
    setPickerOpen(false);
    try {
      const room = await apiRequest("/chat/direct", {
        method: "POST",
        body: JSON.stringify({ otherUserId }),
      });
      await fetchRooms();
      onSelectRoom(room.id, otherName);
    } catch (e) {
      console.error("Failed to start DM", e);
    }
  };

  const togglePin = async (room: ChatRoom) => {
    try {
      await apiRequest(`/chat/rooms/${room.id}/pin`, { method: "PATCH" });
      fetchRooms();
    } catch (e) {
      console.error("Failed to toggle pin", e);
    }
  };

  const deleteRoom = (room: ChatRoom) => {
    Alert.alert(
      "Delete channel",
      `Are you sure you want to delete #${room.name}? All messages will be permanently removed.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await apiRequest(`/chat/rooms/${room.id}`, { method: "DELETE" });
              fetchRooms();
            } catch (e) {
              console.error("Failed to delete room", e);
            }
          },
        },
      ],
    );
  };

  const showAdminActions = (room: ChatRoom) => {
    if (!isAdmin || room.type === "direct") return;
    Alert.alert(
      `#${room.name}`,
      "Admin actions",
      [
        {
          text: room.pinned ? "Unpin channel" : "Pin to top",
          onPress: () => togglePin(room),
        },
        {
          text: "Delete channel",
          style: "destructive",
          onPress: () => deleteRoom(room),
        },
        { text: "Cancel", style: "cancel" },
      ],
    );
  };

  const channels = rooms.filter((r) => r.type !== "direct");
  const directs = rooms.filter((r) => r.type === "direct");
  const visibleRooms = tab === "channels" ? channels : directs;

  const filteredUsers = users.filter((u) => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return true;
    return `${u.firstName} ${u.lastName}`.toLowerCase().includes(q);
  });

  const s = styles(colors);

  if (loading) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
        <View style={s.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <View style={s.header}>
        <Text style={[s.title, { color: colors.foreground }]} accessibilityRole="header">Team Chat</Text>
        <Text style={[s.subtitle, { color: colors.mutedForeground }]}>
          {brand.companyName}
        </Text>
      </View>

      <View style={[s.tabs, { borderBottomColor: colors.border }]} accessibilityRole="tablist">
        {(["channels", "direct"] as const).map((k) => (
          <TouchableOpacity
            key={k}
            onPress={() => setTab(k)}
            style={[s.tab, tab === k && { borderBottomColor: colors.primary }]}
            accessibilityRole="tab"
            accessibilityLabel={k === "channels" ? "Channels tab" : "Direct messages tab"}
            accessibilityState={{ selected: tab === k }}
          >
            <Text style={[s.tabText, { color: tab === k ? colors.primary : colors.mutedForeground }]}>
              {k === "channels" ? "Channels" : "Direct"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === "channels" && isAdmin && (
        <View style={[s.newRoomRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <TextInput
            style={[s.input, { color: colors.foreground }]}
            placeholder="New channel name..."
            placeholderTextColor={colors.mutedForeground}
            value={newRoom}
            onChangeText={setNewRoom}
            onSubmitEditing={createRoom}
            accessibilityLabel="New channel name"
          />
          <TouchableOpacity onPress={createRoom} disabled={creating} style={s.addBtn} accessibilityRole="button" accessibilityLabel="Create channel" accessibilityState={{ disabled: creating, busy: creating }}>
            {creating ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="plus" size={20} color={colors.primary} />}
          </TouchableOpacity>
        </View>
      )}

      {tab === "direct" && (
        <TouchableOpacity
          onPress={openPicker}
          style={[s.newDmBtn, { backgroundColor: colors.primary }]}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Start a new direct message"
        >
          <Feather name="edit" size={16} color="#0c0a08" />
          <Text style={s.newDmText}>New Direct Message</Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={visibleRooms}
        keyExtractor={(r) => r.id}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchRooms(); }} tintColor={colors.primary} />}
        renderItem={({ item }) => {
          const isDirect = item.type === "direct";
          const isSiteChannel = item.type === "site";
          const displayName = isDirect ? (item.otherUserName || "Direct") : `#${item.name}`;
          const initials = isDirect && item.otherUserName
            ? item.otherUserName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
            : null;
          const totalMessages = item.messageCount ?? 0;
          const unreadCount = unreadByRoom[item.id] ?? 0;
          const hasUnread = unreadCount > 0;
          const unreadLabel = hasUnread
            ? `${unreadCount} unread message${unreadCount === 1 ? "" : "s"}`
            : "No unread messages";
          const a11yPieces = [
            isDirect ? `Direct message with ${displayName}` : `Channel ${displayName}`,
            item.pinned ? "Pinned" : null,
            unreadLabel,
            item.lastMessage
              ? `Last message from ${item.lastMessage.userName}: ${item.lastMessage.content}, ${formatDistanceToNow(new Date(item.lastMessage.createdAt), { addSuffix: true })}`
              : "No messages yet",
            totalMessages > 0 ? `${totalMessages} total message${totalMessages === 1 ? "" : "s"}` : null,
          ].filter(Boolean).join(". ");
          return (
            <TouchableOpacity
              style={[
                s.roomCard,
                { backgroundColor: colors.card, borderColor: item.pinned ? colors.primary + "55" : colors.border },
              ]}
              onPress={() => handleSelectRoom(item.id, displayName)}
              onLongPress={() => showAdminActions(item)}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={a11yPieces}
              accessibilityHint={isAdmin && !isDirect ? "Press to open. Long press for admin actions." : "Opens the conversation"}
            >
              <View style={[s.roomIcon, { backgroundColor: colors.primary + "22" }]}>
                {isDirect && initials ? (
                  <Text style={{ color: colors.primary, fontWeight: "700", fontSize: 13 }}>{initials}</Text>
                ) : (
                  <Feather name={isSiteChannel ? "map-pin" : "hash"} size={18} color={colors.primary} />
                )}
              </View>
              <View style={s.roomInfo}>
                <View style={s.roomTopRow}>
                  <View style={s.roomNameRow}>
                    <Text
                      style={[s.roomName, { color: colors.foreground }, hasUnread && s.roomNameUnread]}
                      numberOfLines={1}
                    >
                      {displayName}
                    </Text>
                    {item.pinned && (
                      <Feather name="bookmark" size={12} color={colors.primary} style={{ marginLeft: 4 }} />
                    )}
                    {isSiteChannel && (
                      <View style={[s.siteChip, { backgroundColor: colors.primary + "22" }]}>
                        <Text style={[s.siteChipText, { color: colors.primary }]}>Site</Text>
                      </View>
                    )}
                  </View>
                  {item.lastMessage && (
                    <Text style={[s.time, { color: hasUnread ? colors.primary : colors.mutedForeground }]}>
                      {formatDistanceToNow(new Date(item.lastMessage.createdAt), { addSuffix: true })}
                    </Text>
                  )}
                </View>
                {item.lastMessage ? (
                  <Text
                    style={[s.lastMsg, { color: hasUnread ? colors.foreground : colors.mutedForeground }, hasUnread && s.lastMsgUnread]}
                    numberOfLines={1}
                  >
                    {!isDirect && <Text style={{ fontWeight: "600" }}>{item.lastMessage.userName}: </Text>}
                    {item.lastMessage.content}
                  </Text>
                ) : (
                  <Text style={[s.lastMsg, { color: colors.mutedForeground }]}>No messages yet</Text>
                )}
              </View>
              {hasUnread ? (
                <View
                  style={[s.unreadBadge, { backgroundColor: colors.primary }]}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  <Text style={s.unreadBadgeText}>{unreadCount > 99 ? "99+" : unreadCount}</Text>
                </View>
              ) : (
                <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
              )}
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={() => (
          <View style={s.center}>
            <Feather name={tab === "direct" ? "user" : "message-circle"} size={48} color={colors.mutedForeground} />
            <Text style={[s.emptyText, { color: colors.mutedForeground }]}>
              {tab === "direct" ? "No direct messages yet" : "No channels yet"}
            </Text>
          </View>
        )}
      />

      <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
        <View style={s.modalBackdrop}>
          <SafeAreaView style={[s.modalSheet, { backgroundColor: colors.background }]} edges={["bottom"]}>
            <View style={[s.modalHeader, { borderBottomColor: colors.border }]}>
              <Text style={[s.modalTitle, { color: colors.foreground }]} accessibilityRole="header">Start a Direct Message</Text>
              <TouchableOpacity onPress={() => setPickerOpen(false)} accessibilityRole="button" accessibilityLabel="Close people picker">
                <Feather name="x" size={22} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            <View style={[s.searchRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Feather name="search" size={16} color={colors.mutedForeground} />
              <TextInput
                style={[s.searchInput, { color: colors.foreground }]}
                placeholder="Search people..."
                placeholderTextColor={colors.mutedForeground}
                value={userSearch}
                onChangeText={setUserSearch}
                autoFocus={Platform.OS === "web"}
                accessibilityLabel="Search people"
                accessibilityHint="Filters the list of people you can message"
              />
            </View>
            {usersLoading ? (
              <View style={s.center}><ActivityIndicator color={colors.primary} /></View>
            ) : (
              <FlatList
                data={filteredUsers}
                keyExtractor={(u) => u.id}
                contentContainerStyle={{ padding: 16, gap: 6 }}
                renderItem={({ item }) => {
                  const name = `${item.firstName} ${item.lastName}`;
                  const roleLabel = item.role === "admin" ? "Admin" : "Officer";
                  return (
                    <TouchableOpacity
                      style={[s.userRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                      onPress={() => startDirect(item.id, name)}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel={`Message ${name}, ${roleLabel}`}
                    >
                      <View style={[s.roomIcon, { backgroundColor: colors.primary + "22" }]}>
                        <Text style={{ color: colors.primary, fontWeight: "700", fontSize: 13 }}>
                          {`${item.firstName[0]}${item.lastName[0]}`.toUpperCase()}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.userName, { color: colors.foreground }]}>{name}</Text>
                        <Text style={[s.userRole, { color: colors.mutedForeground }]}>
                          {item.role === "admin" ? "Admin" : "Officer"}
                        </Text>
                      </View>
                      <Feather name="message-square" size={18} color={colors.primary} />
                    </TouchableOpacity>
                  );
                }}
                ListEmptyComponent={() => (
                  <Text style={[s.lastMsg, { color: colors.mutedForeground, textAlign: "center", marginTop: 32 }]}>
                    No people found
                  </Text>
                )}
              />
            )}
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  title: { fontSize: 24, fontWeight: "700" },
  subtitle: { fontSize: 13, marginTop: 2 },
  tabs: { flexDirection: "row", borderBottomWidth: 1, marginBottom: 8 },
  tab: { flex: 1, paddingVertical: 12, alignItems: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabText: { fontSize: 14, fontWeight: "600" },
  newRoomRow: {
    flexDirection: "row", alignItems: "center", marginHorizontal: 16, marginBottom: 12,
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12,
  },
  input: { flex: 1, height: 44, fontSize: 15 },
  addBtn: { paddingLeft: 8 },
  newDmBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    marginHorizontal: 16, marginBottom: 12, paddingVertical: 12, borderRadius: 10,
  },
  newDmText: { color: "#0c0a08", fontSize: 15, fontWeight: "700" },
  list: { paddingHorizontal: 16, gap: 8, paddingBottom: 100, flexGrow: 1 },
  roomCard: {
    flexDirection: "row", alignItems: "center", padding: 14,
    borderRadius: 12, borderWidth: 1, gap: 12,
  },
  roomIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  roomInfo: { flex: 1 },
  roomTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  roomNameRow: { flexDirection: "row", alignItems: "center", flex: 1 },
  roomName: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
  roomNameUnread: { fontWeight: "800" },
  siteChip: {
    marginLeft: 6, paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: 4,
  },
  siteChipText: { fontSize: 10, fontWeight: "700" },
  time: { fontSize: 12 },
  lastMsg: { fontSize: 13, marginTop: 2 },
  lastMsgUnread: { fontWeight: "600" },
  unreadBadge: {
    minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6,
    alignItems: "center", justifyContent: "center",
  },
  unreadBadgeText: { color: "#0c0a08", fontSize: 12, fontWeight: "800" },
  emptyText: { marginTop: 12, fontSize: 16 },
  modalBackdrop: { flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" },
  modalSheet: { maxHeight: "85%", minHeight: "60%", borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: "hidden" },
  modalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1,
  },
  modalTitle: { fontSize: 17, fontWeight: "700" },
  searchRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 16, marginTop: 12, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12,
  },
  searchInput: { flex: 1, height: 42, fontSize: 15 },
  userRow: {
    flexDirection: "row", alignItems: "center", padding: 12,
    borderRadius: 12, borderWidth: 1, gap: 12,
  },
  userName: { fontSize: 15, fontWeight: "600" },
  userRole: { fontSize: 12, marginTop: 2 },
});
