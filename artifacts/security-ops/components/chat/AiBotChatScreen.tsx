import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/utils/api";
import {
  checkAssistantConfigured,
  dismissSuggestion,
  fetchAssistantReply,
  fetchSuggestions,
  resolvePendingActionOutcome,
  type PendingAction,
  type Suggestion,
  type Turn,
} from "./aiBotChat";
import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * Mobile entry point for the same Gemini-backed bot the admin portal calls
 * "Secure Ops AI Bot" — reached from the Chat area as its own private
 * conversation, never mixed into a shared chat_rooms thread.
 *
 * It talks to the exact same routes the portal page does
 * (/assistant/status, /assistant/chat, /assistant/actions/:id/approve|discard)
 * with THIS user's own bearer token (see utils/api apiRequest), which is what
 * keeps action-safety intact here: the bot has no privileged path server-side
 * (see lib/assistant/internalDispatch dispatchAsUser), so an officer or site
 * manager can only ever get it to do what their own role/site permissions
 * would already let them do through the normal screens. No client-side
 * allow/deny logic is needed or wanted on top of that.
 *
 * The request/response logic for each of those calls lives in ./aiBotChat
 * (RN-free) so it can be exercised directly in Vitest — see that module's
 * doc comment.
 *
 * Below the chat sits a collapsible card of the same "adoption suggestion"
 * findings the admin-portal side panel shows (GET /assistant/suggestions,
 * POST /assistant/suggestions/:id/dismiss) — scoped server-side to this
 * user's role/sites, so an officer typically sees none and a site manager
 * may see a couple. Deliberately independent of the chat/Gemini
 * connectivity check: it works even when the assistant is not configured.
 */

const CATEGORY_LABEL: Record<Suggestion["category"], string> = {
  money: "Revenue",
  compliance: "Compliance",
  client: "Client-facing",
  dispatch: "Workload",
  admin: "Admin",
};

const STARTERS = [
  "What can you help me with?",
  "How do I request a shift swap?",
  "Show me my recent time entries",
];

interface Props {
  /** Route to fall back to if there is nothing to go back to (rare — this
   * screen is always pushed from a chat list). Employee vs admin shells push
   * from different roots, so the caller supplies the right one. */
  backHref?: string;
}

export default function AiBotChatScreen({ backHref = "/(employee)/chat" }: Props) {
  const colors = useColors();
  const router = useRouter();
  const tabBarHeight = Platform.OS === "ios" ? 84 : 60;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [findings, setFindings] = useState<Suggestion[]>([]);
  const [findingsLoading, setFindingsLoading] = useState(true);
  const [findingsCollapsed, setFindingsCollapsed] = useState(false);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    void (async () => {
      setConfigured(await checkAssistantConfigured(apiRequest));
    })();
  }, []);

  const loadFindings = useCallback(async () => {
    setFindingsLoading(true);
    try {
      setFindings(await fetchSuggestions(apiRequest));
    } catch {
      // Supplementary panel — a failed fetch just leaves it empty; chat still works.
    } finally {
      setFindingsLoading(false);
    }
  }, []);

  useEffect(() => { void loadFindings(); }, [loadFindings]);

  const scrollToEnd = () => setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;
    const priorTurns = turns;
    setTurns((prev) => [...prev, { role: "user", content: message }]);
    setInput("");
    setSending(true);
    scrollToEnd();
    const reply = await fetchAssistantReply(apiRequest, priorTurns, message);
    setTurns((prev) => [...prev, reply]);
    setSending(false);
    scrollToEnd();
    // An action that ran may have resolved a finding.
    if (reply.actionsTaken?.some((a) => a.ok)) void loadFindings();
  }

  async function resolvePending(turnIndex: number, action: PendingAction, approve: boolean) {
    setApproving(action.id);
    const resolution = await resolvePendingActionOutcome(apiRequest, action, approve);
    setTurns((prev) => prev.map((t, i) => (i === turnIndex ? { ...t, resolution } : t)));
    setApproving(null);
    if (resolution.ok) void loadFindings();
  }

  async function dismissFinding(id: string) {
    setFindings((prev) => prev.filter((f) => f.id !== id));
    if (!(await dismissSuggestion(apiRequest, id))) {
      // The dismiss endpoint didn't confirm — pull the real list back rather
      // than leaving a suggestion invisible that the server still has active.
      void loadFindings();
    }
  }

  const s = styles(colors);

  const renderTurn = ({ item, index }: { item: Turn; index: number }) => {
    const mine = item.role === "user";
    return (
      <View style={[s.msgRow, mine && s.msgRowMine]}>
        {!mine && (
          <View style={[s.avatar, { backgroundColor: colors.primary + "33" }]}>
            <Feather name="zap" size={14} color={colors.primary} />
          </View>
        )}
        <View
          style={[
            s.bubble,
            mine ? s.bubbleMine : s.bubbleOther,
            { backgroundColor: mine ? colors.primary : colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[s.msgText, { color: mine ? colors.primaryForeground : colors.foreground }]}>
            {item.content}
          </Text>

          {!!item.actionsTaken?.length && (
            <View style={{ marginTop: 6, gap: 3 }}>
              {item.actionsTaken.map((a, j) => (
                <View key={j} style={{ flexDirection: "row", alignItems: "flex-start", gap: 5 }}>
                  <Feather
                    name={a.ok ? "check" : "x"}
                    size={12}
                    color={a.ok ? colors.success : colors.destructive}
                    style={{ marginTop: 2 }}
                  />
                  <Text style={[s.actionText, { color: a.ok ? colors.success : colors.destructive }]}>
                    {a.message}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {item.pendingAction && !item.resolution && (
            <View style={[s.pendingCard, { borderColor: colors.primary + "66", backgroundColor: colors.background }]}>
              <Text style={[s.pendingLabel, { color: colors.primary }]}>NEEDS YOUR APPROVAL</Text>
              <Text style={[s.pendingSummary, { color: colors.foreground }]}>{item.pendingAction.summary}</Text>
              {item.pendingAction.details.map((d) => (
                <Text key={d.label} style={[s.pendingDetail, { color: colors.mutedForeground }]}>
                  <Text style={{ fontWeight: "600" }}>{d.label}: </Text>
                  {d.value}
                </Text>
              ))}
              <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                <TouchableOpacity
                  onPress={() => void resolvePending(index, item.pendingAction!, true)}
                  disabled={approving === item.pendingAction.id}
                  style={[s.approveBtn, { backgroundColor: colors.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Approve: ${item.pendingAction.summary}`}
                  accessibilityState={{ disabled: approving === item.pendingAction.id, busy: approving === item.pendingAction.id }}
                >
                  {approving === item.pendingAction.id ? (
                    <ActivityIndicator size="small" color={colors.primaryForeground} />
                  ) : (
                    <Feather name="check" size={14} color={colors.primaryForeground} />
                  )}
                  <Text style={[s.approveBtnText, { color: colors.primaryForeground }]}>Approve</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => void resolvePending(index, item.pendingAction!, false)}
                  disabled={approving === item.pendingAction.id}
                  style={[s.cancelBtn, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel this action"
                >
                  <Text style={[s.cancelBtnText, { color: colors.foreground }]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {item.resolution && (
            <Text style={[s.resolutionText, { color: item.resolution.ok ? colors.success : colors.destructive }]}>
              {item.resolution.text}
            </Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background, paddingBottom: tabBarHeight }]} edges={["top", "bottom"]}>
      <View style={[s.topBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace(backHref as any))}
          style={s.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel="Back to chats"
        >
          <Feather name="chevron-left" size={26} color={colors.foreground} />
        </TouchableOpacity>
        <Feather name="zap" size={18} color={colors.primary} />
        <Text style={[s.roomTitle, { color: colors.foreground }]} numberOfLines={1} accessibilityRole="header">
          Secure Ops AI Bot
        </Text>
        <View style={[s.newBadge, { borderColor: colors.primary }]}>
          <Text style={[s.newBadgeText, { color: colors.primary }]}>NEW</Text>
        </View>
      </View>

      {configured === false && (
        <View style={[s.warningBanner, { borderColor: colors.destructive + "55", backgroundColor: colors.destructive + "18" }]}>
          <Feather name="alert-triangle" size={14} color={colors.destructive} style={{ marginTop: 1 }} />
          <Text style={[s.warningText, { color: colors.destructive }]}>
            Secure Ops AI Bot is not connected right now. Try again later.
          </Text>
        </View>
      )}

      {!findingsLoading && findings.length > 0 && (
        <View style={[s.findingsCard, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <TouchableOpacity
            onPress={() => setFindingsCollapsed((c) => !c)}
            style={s.findingsHeader}
            accessibilityRole="button"
            accessibilityLabel={`${findingsCollapsed ? "Show" : "Hide"} suggestions, ${findings.length} available`}
            accessibilityState={{ expanded: !findingsCollapsed }}
          >
            <Feather name="compass" size={14} color={colors.primary} />
            <Text style={[s.findingsTitle, { color: colors.foreground }]}>
              What you're not using ({findings.length})
            </Text>
            <Feather
              name={findingsCollapsed ? "chevron-down" : "chevron-up"}
              size={18}
              color={colors.mutedForeground}
            />
          </TouchableOpacity>

          {!findingsCollapsed && (
            <View style={s.findingsList}>
              {findings.map((f) => (
                <View key={f.id} style={[s.findingItem, { borderColor: colors.border }]}>
                  <View style={s.findingItemHeader}>
                    <View style={[s.categoryPill, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
                      <Text style={[s.categoryPillText, { color: colors.mutedForeground }]}>
                        {CATEGORY_LABEL[f.category] ?? "Suggestion"}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => void dismissFinding(f.id)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel={`Dismiss suggestion: ${f.title}`}
                    >
                      <Feather name="x" size={15} color={colors.mutedForeground} />
                    </TouchableOpacity>
                  </View>
                  <Text style={[s.findingTitle, { color: colors.foreground }]}>{f.title}</Text>
                  <Text style={[s.findingEvidence, { color: colors.mutedForeground }]}>{f.evidence}</Text>
                  <Text style={[s.findingBenefit, { color: colors.foreground }]}>{f.benefit}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      <FlatList
        ref={listRef}
        data={turns}
        keyExtractor={(_, i) => String(i)}
        renderItem={renderTurn}
        contentContainerStyle={s.list}
        ListEmptyComponent={() => (
          <View style={s.center}>
            <Feather name="zap" size={40} color={colors.mutedForeground} />
            <Text style={[s.emptyText, { color: colors.mutedForeground }]}>
              Ask a question, or describe what you want done.
            </Text>
            <View style={s.startersWrap}>
              {STARTERS.map((starter) => (
                <TouchableOpacity
                  key={starter}
                  onPress={() => void send(starter)}
                  disabled={sending || configured === false}
                  style={[s.starterChip, { borderColor: colors.border, backgroundColor: colors.card }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Ask: ${starter}`}
                >
                  <Text style={[s.starterText, { color: colors.foreground }]}>{starter}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        ListFooterComponent={
          sending ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 }}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>Thinking…</Text>
            </View>
          ) : null
        }
      />

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[s.inputBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
          <TextInput
            style={[s.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
            placeholder={configured === false ? "Secure Ops AI Bot not connected" : "Ask a question…"}
            placeholderTextColor={colors.mutedForeground}
            value={input}
            onChangeText={setInput}
            multiline
            maxLength={1000}
            editable={configured !== false}
            accessibilityLabel="Message Secure Ops AI Bot"
            accessibilityHint="Type your question, then activate the send button"
          />
          <TouchableOpacity
            onPress={() => void send(input)}
            disabled={!input.trim() || sending || configured === false}
            style={s.sendBtn}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !input.trim() || sending || configured === false, busy: sending }}
          >
            <Feather name="send" size={20} color={input.trim() && configured !== false ? colors.primary : colors.mutedForeground} />
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
  newBadge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  newBadgeText: { fontSize: 9, fontWeight: "800", letterSpacing: 0.4 },
  warningBanner: {
    flexDirection: "row", gap: 8, alignItems: "flex-start", marginHorizontal: 12, marginTop: 10,
    padding: 10, borderRadius: 10, borderWidth: 1,
  },
  warningText: { flex: 1, fontSize: 12.5, lineHeight: 17 },
  findingsCard: { marginHorizontal: 12, marginTop: 10, borderRadius: 10, borderWidth: 1, overflow: "hidden" },
  findingsHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  findingsTitle: { flex: 1, fontSize: 13, fontWeight: "700" },
  findingsList: { paddingHorizontal: 10, paddingBottom: 10, gap: 8 },
  findingItem: { borderTopWidth: 1, paddingTop: 8, paddingHorizontal: 2 },
  findingItemHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  categoryPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  categoryPillText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.3, textTransform: "uppercase" },
  findingTitle: { fontSize: 13.5, fontWeight: "600", marginTop: 6 },
  findingEvidence: { fontSize: 12, lineHeight: 16, marginTop: 3 },
  findingBenefit: { fontSize: 12, lineHeight: 16, marginTop: 4 },
  list: { paddingHorizontal: 12, paddingVertical: 12, gap: 10, flexGrow: 1, justifyContent: "flex-end" },
  emptyText: { marginTop: 10, fontSize: 14, textAlign: "center" },
  startersWrap: { marginTop: 16, gap: 8, alignItems: "stretch", width: "100%" },
  starterChip: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  starterText: { fontSize: 13 },
  msgRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  msgRowMine: { flexDirection: "row-reverse" },
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  bubble: { maxWidth: "85%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1 },
  bubbleMine: { borderBottomRightRadius: 4 },
  bubbleOther: { borderBottomLeftRadius: 4 },
  msgText: { fontSize: 15, lineHeight: 21 },
  actionText: { fontSize: 12, flexShrink: 1 },
  pendingCard: { marginTop: 10, borderRadius: 10, borderWidth: 1, padding: 10 },
  pendingLabel: { fontSize: 10, fontWeight: "800", letterSpacing: 0.4 },
  pendingSummary: { fontSize: 13.5, fontWeight: "600", marginTop: 4 },
  pendingDetail: { fontSize: 12, marginTop: 3 },
  approveBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14,
    paddingVertical: 8, borderRadius: 8,
  },
  approveBtnText: { fontSize: 13, fontWeight: "700" },
  cancelBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  cancelBtnText: { fontSize: 13, fontWeight: "600" },
  resolutionText: { marginTop: 8, fontSize: 12.5, fontWeight: "600" },
  inputBar: {
    flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, gap: 8,
  },
  input: {
    flex: 1, borderRadius: 20, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8,
    fontSize: 15, maxHeight: 100,
  },
  sendBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
});
