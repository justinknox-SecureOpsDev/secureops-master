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

  const messages = (
    <FeatureGate feature="chat">
      <ChatRoomsList
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
              onPress={() => setActiveTab(t)}
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
        <FeatureGate feature="radio">
          <RadioScreen />
        </FeatureGate>
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
