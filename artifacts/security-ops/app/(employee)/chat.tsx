import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import ChatRoomsList from "@/components/chat/ChatRoomsList";
import { FeatureGate } from "@/components/FeatureGate";
import { useFeatures, isEnabled } from "@/hooks/useFeatures";
import { useColors } from "@/hooks/useColors";
import RadioScreen from "@/components/radio/RadioScreen";

type ChatTab = "messages" | "radio";

export default function EmployeeChatScreen() {
  const router = useRouter();
  const flags = useFeatures();
  const colors = useColors();
  const radioEnabled = isEnabled(flags, "radio");
  const [activeTab, setActiveTab] = useState<ChatTab>("messages");
  // RadioScreen stays mounted behind display:none, so expo-router focus never
  // fires when the user flips to the Radio sub-tab. Bump this epoch on each
  // switch to Radio so RadioScreen refetches its channel roster (fresh
  // site-channel list) — see the refreshEpoch prop on RadioScreen.
  const [radioEpoch, setRadioEpoch] = useState(0);
  // Mirror-image epoch for the Messages pane: ChatRoomsList is also kept
  // permanently mounted, so flipping Radio → Messages would otherwise never
  // refetch the room list (a room created while the user sat on Radio would
  // stay invisible until the whole Chat tab regained focus).
  const [messagesEpoch, setMessagesEpoch] = useState(0);

  const selectTab = (t: ChatTab) => {
    setActiveTab((prev) => {
      if (t === "radio" && prev !== "radio") setRadioEpoch((e) => e + 1);
      if (t === "messages" && prev !== "messages") setMessagesEpoch((e) => e + 1);
      return t;
    });
  };

  const messages = (
    <FeatureGate feature="chat">
      <ChatRoomsList
        refreshEpoch={messagesEpoch}
        onSelectRoom={(id, name) =>
          router.push({ pathname: "/(employee)/chat/[id]", params: { id, name } })
        }
      />
    </FeatureGate>
  );

  if (!radioEnabled) {
    return messages;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        style={[styles.tabBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}
        accessibilityRole="tablist"
      >
        {(["messages", "radio"] as ChatTab[]).map((t) => {
          const active = activeTab === t;
          const label = t === "messages" ? "Messages" : "Radio";
          return (
            <TouchableOpacity
              key={t}
              style={[styles.tab, active && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
              onPress={() => selectTab(t)}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: active }}
            >
              <Text
                style={[
                  styles.tabText,
                  { color: active ? colors.primary : colors.mutedForeground, fontWeight: active ? "700" : "400" },
                ]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={{ flex: 1, display: activeTab === "messages" ? "flex" : "none" }}>
        {messages}
      </View>
      <View style={{ flex: 1, display: activeTab === "radio" ? "flex" : "none" }}>
        <RadioScreen refreshEpoch={radioEpoch} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabText: {
    fontSize: 14,
  },
});
