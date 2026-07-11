import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, AccessibilityInfo,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/contexts/AuthContext";
import { useChat } from "@/contexts/ChatContext";
import { apiRequest } from "@/utils/api";
import { formatDistanceToNow } from "date-fns";
import type { ChatMessage } from "@/contexts/ChatContext";

interface Props {
  roomId: string;
  roomName: string;
}

export default function ChatRoomScreen({ roomId, roomName }: Props) {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const { subscribeToRoom, subscribeToDeletes, sendMessage, deleteMessage, markRoomRead } = useChat();
  const tabBarHeight = Platform.OS === "ios" ? 84 : 60;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);

  const loadMessages = useCallback(async () => {
    try {
      const data = await apiRequest(`/chat/rooms/${roomId}/messages?limit=50`);
      setMessages(data);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    loadMessages();
    // Entering the room clears its unread badge (server watermark + local state).
    void markRoomRead(roomId);
    const unsubNew = subscribeToRoom(roomId, (msg) => {
      let isNew = false;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        isNew = true;
        return [...prev, msg];
      });
      // Messages arriving while the room is open are already seen — keep the
      // read watermark current so the badge never re-appears behind the user.
      if (msg.userId !== user?.id) {
        void markRoomRead(roomId);
        // Announce incoming messages from others so screen-reader users hear
        // new chat without having to manually re-scan the message list.
        if (isNew) {
          AccessibilityInfo.announceForAccessibility(`New message from ${msg.userName}: ${msg.content}`);
        }
      }
      // Newest messages render at the top — snap back up so the new one is visible.
      setTimeout(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }), 100);
    });
    const unsubDel = subscribeToDeletes(roomId, (messageId) => {
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    });
    return () => { unsubNew(); unsubDel(); };
  }, [roomId, subscribeToRoom, subscribeToDeletes, loadMessages, markRoomRead, user?.id]);

  useEffect(() => {
    if (!loading && messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }), 200);
    }
  }, [loading]);

  // Display order: most recent first (newest at the top of the screen).
  const displayMessages = [...messages].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const handleSend = async () => {
    if (!text.trim() || sending) return;
    const content = text.trim();
    setText("");
    setSending(true);
    try {
      await sendMessage(roomId, content);
    } catch (e) {
      console.error("Send failed", e);
      setText(content);
    } finally {
      setSending(false);
    }
  };

  const s = styles(colors);
  const isMe = (userId: string) => userId === user?.id;
  const isAdmin = user?.role === "admin";

  const handleLongPressMessage = (msg: ChatMessage) => {
    const canDelete = isMe(msg.userId) || isAdmin;
    if (!canDelete) return;
    const doDelete = async () => {
      // Optimistic: remove locally; WS will confirm for everyone else.
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      try {
        await deleteMessage(msg.id);
      } catch (e: any) {
        // Roll back on failure
        setMessages((prev) => prev.some((m) => m.id === msg.id) ? prev : [...prev, msg].sort((a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        ));
        const message = e?.response?.data?.message || e?.message || "Could not delete message.";
        if (Platform.OS === "web") window.alert(message);
        else Alert.alert("Delete failed", message);
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm("Delete this message? This cannot be undone.")) doDelete();
    } else {
      Alert.alert("Delete message?", "This cannot be undone.", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doDelete },
      ]);
    }
  };

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const mine = isMe(item.userId);
    const canDelete = mine || isAdmin;
    const senderForA11y = mine ? "You" : item.userName;
    const whenForA11y = formatDistanceToNow(new Date(item.createdAt), { addSuffix: true });
    return (
      <TouchableOpacity
        activeOpacity={canDelete ? 0.7 : 1}
        onLongPress={() => handleLongPressMessage(item)}
        delayLongPress={350}
        style={[s.msgRow, mine && s.msgRowMine]}
        accessible
        accessibilityRole={canDelete ? "button" : "text"}
        accessibilityLabel={`${senderForA11y} said: ${item.content}. ${whenForA11y}.`}
        accessibilityHint={canDelete ? "Double tap and hold to delete this message" : undefined}
      >
        {!mine && (
          <View style={[s.avatar, { backgroundColor: colors.primary + "33" }]}>
            <Text style={[s.avatarText, { color: colors.primary }]}>
              {item.userName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
            </Text>
          </View>
        )}
        <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleOther, {
          backgroundColor: mine ? colors.primary : colors.card,
          borderColor: colors.border,
        }]}>
          {!mine && (
            <Text style={[s.senderName, { color: colors.primary }]}>{item.userName}</Text>
          )}
          <Text style={[s.msgText, { color: mine ? "#080c18" : colors.foreground }]}>
            {item.content}
          </Text>
          <Text style={[s.msgTime, { color: mine ? "#080c18aa" : colors.mutedForeground }]}>
            {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background, paddingBottom: tabBarHeight }]} edges={["top", "bottom"]}>
      <View style={[s.topBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/(employee)/chat"))}
          style={s.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel="Back to chats"
        >
          <Feather name="chevron-left" size={26} color={colors.foreground} />
        </TouchableOpacity>
        <Feather name="hash" size={18} color={colors.primary} />
        <Text style={[s.roomTitle, { color: colors.foreground }]} numberOfLines={1} accessibilityRole="header">
          {roomName}
        </Text>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          ref={listRef}
          data={displayMessages}
          keyExtractor={(m) => m.id}
          renderItem={renderMessage}
          contentContainerStyle={s.list}
          ListEmptyComponent={() => (
            <View style={s.center}>
              <Feather name="message-circle" size={48} color={colors.mutedForeground} />
              <Text style={[s.emptyText, { color: colors.mutedForeground }]}>
                No messages yet. Say hello!
              </Text>
            </View>
          )}
        />
      )}

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[s.inputBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
          <TextInput
            style={[s.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
            placeholder="Message..."
            placeholderTextColor={colors.mutedForeground}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={1000}
            accessibilityLabel={`Message ${roomName}`}
            accessibilityHint="Type your message, then activate the send button"
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!text.trim() || sending}
            style={s.sendBtn}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !text.trim() || sending, busy: sending }}
          >
            {sending
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Feather name="send" size={20} color={text.trim() ? colors.primary : colors.mutedForeground} />
            }
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  topBar: {
    flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8,
    paddingVertical: 10, borderBottomWidth: 1,
  },
  backBtn: { padding: 6, marginRight: 2 },
  roomTitle: { fontSize: 16, fontWeight: "700", flex: 1 },
  list: { paddingHorizontal: 12, paddingVertical: 12, gap: 10, flexGrow: 1 },
  msgRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  msgRowMine: { flexDirection: "row-reverse" },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 12, fontWeight: "700" },
  bubble: {
    maxWidth: "75%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1,
  },
  bubbleMine: { borderBottomRightRadius: 4 },
  bubbleOther: { borderBottomLeftRadius: 4 },
  senderName: { fontSize: 12, fontWeight: "600", marginBottom: 2 },
  msgText: { fontSize: 15, lineHeight: 21 },
  msgTime: { fontSize: 11, marginTop: 4, textAlign: "right" },
  inputBar: {
    flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, gap: 8,
  },
  input: {
    flex: 1, borderRadius: 20, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8,
    fontSize: 15, maxHeight: 100,
  },
  sendBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  emptyText: { marginTop: 12, fontSize: 16 },
});
