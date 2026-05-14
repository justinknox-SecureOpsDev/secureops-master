import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
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
  const { user } = useAuth();
  const { subscribeToRoom, sendMessage } = useChat();
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
    const unsub = subscribeToRoom(roomId, (msg) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    });
    return unsub;
  }, [roomId, subscribeToRoom, loadMessages]);

  useEffect(() => {
    if (!loading && messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 200);
    }
  }, [loading]);

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

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const mine = isMe(item.userId);
    return (
      <View style={[s.msgRow, mine && s.msgRowMine]}>
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
      </View>
    );
  };

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]} edges={["bottom"]}>
      <View style={[s.topBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Feather name="hash" size={18} color={colors.primary} />
        <Text style={[s.roomTitle, { color: colors.foreground }]}>{roomName}</Text>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
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
          />
          <TouchableOpacity onPress={handleSend} disabled={!text.trim() || sending} style={s.sendBtn}>
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
    flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16,
    paddingVertical: 12, borderBottomWidth: 1,
  },
  roomTitle: { fontSize: 16, fontWeight: "700" },
  list: { paddingHorizontal: 12, paddingVertical: 12, gap: 10, flexGrow: 1, justifyContent: "flex-end" },
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
