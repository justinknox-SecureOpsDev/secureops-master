import React, { useState } from "react";
import { Modal, View, Text, StyleSheet, TouchableOpacity, Pressable } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useTour } from "@/contexts/TourContext";

type Step = {
  icon: React.ComponentProps<typeof Feather>["name"];
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    icon: "home",
    title: "Home",
    body: "Your daily snapshot — hours this week, your next shift, and quick links. The red bar at the top is the Emergency button: press and hold for 3 seconds to alert dispatch and open a call to 911.",
  },
  {
    icon: "calendar",
    title: "My Shifts",
    body: "See shifts you're booked on and claim open shifts that match your license level. Tap Reserve to grab one — it's yours instantly.",
  },
  {
    icon: "clock",
    title: "Clock In / Out",
    body: "Clock in when you arrive on site (we use your location to confirm you're within the geofence) and clock out at the end of your shift. Your hours flow straight to payroll.",
  },
  {
    icon: "alert-triangle",
    title: "Incidents",
    body: "File a report any time something happens on shift — break-ins, medical, suspicious activity. Add photos and notes; dispatch and the client see it immediately.",
  },
  {
    icon: "message-circle",
    title: "Chat",
    body: "Real-time channels with dispatch and your team — this replaces WhatsApp for ops. Check in here when you start a shift.",
  },
];

export default function WelcomeTour() {
  const { isOpen, close } = useTour();
  const colors = useColors();
  const [idx, setIdx] = useState(0);

  if (!isOpen) return null;

  const step = STEPS[idx];
  const isLast = idx === STEPS.length - 1;

  const next = () => {
    if (isLast) {
      setIdx(0);
      close();
    } else {
      setIdx(idx + 1);
    }
  };
  const back = () => { if (idx > 0) setIdx(idx - 1); };
  const skip = () => {
    setIdx(0);
    close();
  };

  return (
    <Modal
      transparent
      animationType="fade"
      visible={isOpen}
      onRequestClose={skip}
      accessibilityViewIsModal
    >
      <Pressable
        style={styles.backdrop}
        onPress={skip}
        accessibilityLabel="Dismiss app tour"
        testID="welcome-tour-backdrop"
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          testID="welcome-tour-card"
        >
          <View style={styles.headerRow}>
            <Text style={[styles.stepLabel, { color: colors.mutedForeground }]}>
              Step {idx + 1} of {STEPS.length}
            </Text>
            <TouchableOpacity
              onPress={skip}
              accessibilityLabel="Close app tour"
              testID="welcome-tour-close"
              hitSlop={8}
            >
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          {idx === 0 && (
            <Text style={[styles.welcome, { color: colors.accent }]}>
              Welcome to {process.env.EXPO_PUBLIC_APP_NAME ?? "SecureOps"}
            </Text>
          )}

          <View style={[styles.iconWrap, { backgroundColor: colors.primary + "20", borderColor: colors.primary + "60" }]}>
            <Feather name={step.icon} size={28} color={colors.primary} />
          </View>

          <Text style={[styles.title, { color: colors.foreground }]}>{step.title}</Text>
          <Text style={[styles.body, { color: colors.mutedForeground }]}>{step.body}</Text>

          <View style={styles.dots}>
            {STEPS.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  { backgroundColor: i === idx ? colors.primary : colors.border },
                ]}
              />
            ))}
          </View>

          <View style={styles.actions}>
            {idx > 0 ? (
              <TouchableOpacity
                onPress={back}
                style={[styles.btnGhost, { borderColor: colors.border }]}
                testID="welcome-tour-back"
              >
                <Text style={[styles.btnGhostText, { color: colors.foreground }]}>Back</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={skip}
                style={[styles.btnGhost, { borderColor: colors.border }]}
                testID="welcome-tour-skip"
              >
                <Text style={[styles.btnGhostText, { color: colors.mutedForeground }]}>Skip</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={next}
              style={[styles.btnPrimary, { backgroundColor: colors.primary }]}
              testID="welcome-tour-next"
            >
              <Text style={[styles.btnPrimaryText, { color: colors.primaryForeground }]}>
                {isLast ? "Got it" : "Next"}
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  stepLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 1.5 },
  welcome: { fontSize: 12, fontWeight: "800", letterSpacing: 2, marginTop: -4 },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    marginTop: 4,
  },
  title: { fontSize: 20, fontWeight: "700" },
  body: { fontSize: 14, lineHeight: 20 },
  dots: { flexDirection: "row", gap: 6, marginTop: 8 },
  dot: { width: 22, height: 4, borderRadius: 2 },
  actions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  btnGhost: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  btnGhostText: { fontSize: 14, fontWeight: "600" },
  btnPrimary: { paddingHorizontal: 22, paddingVertical: 11, borderRadius: 8 },
  btnPrimaryText: { fontSize: 14, fontWeight: "700" },
});
