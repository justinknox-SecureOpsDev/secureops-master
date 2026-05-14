import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Image,
} from "react-native";
import { useAuth } from "@/contexts/AuthContext";
import { useLogin } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const { login: setAuthContext } = useAuth();
  const colors = useColors();
  const loginMutation = useLogin();

  const handleLogin = async () => {
    if (!email || !password) return;
    try {
      const response = await loginMutation.mutateAsync({ data: { email, password } });
      await setAuthContext(response.user, response.token);
    } catch (error) {
      // error displayed via loginMutation.error
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Gold radial glow behind logo */}
      <View style={styles.glow} />

      <View style={styles.content}>
        {/* Logo */}
        <View style={styles.logoWrap}>
          <Image
            source={require("@/assets/images/logo.jpeg")}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>

        {/* Brand text */}
        <View style={styles.brandBlock}>
          <Text style={[styles.brandName, { color: colors.primary }]}>WILLIAMS COUNCIL</Text>
          <Text style={[styles.brandSub, { color: colors.foreground }]}>SECURITY GROUP</Text>
          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: colors.primary }]} />
            <Text style={[styles.motto, { color: colors.mutedForeground }]}>PROTECTION WITH PASSION</Text>
            <View style={[styles.dividerLine, { backgroundColor: colors.primary }]} />
          </View>
        </View>

        {/* Login card */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>COMMAND ACCESS</Text>

          {loginMutation.error && (
            <View style={[styles.errorBox, { backgroundColor: colors.destructive + "25", borderColor: colors.destructive }]}>
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={{ color: colors.destructive, fontSize: 13, flex: 1 }}>
                {(loginMutation.error as any)?.message || "Invalid credentials. Please try again."}
              </Text>
            </View>
          )}

          <View style={[styles.inputWrap, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
            <Feather name="mail" size={16} color={colors.mutedForeground} />
            <TextInput
              style={[styles.input, { color: colors.foreground }]}
              placeholder="Email address"
              placeholderTextColor={colors.mutedForeground}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          <View style={[styles.inputWrap, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
            <Feather name="lock" size={16} color={colors.mutedForeground} />
            <TextInput
              style={[styles.input, { color: colors.foreground }]}
              placeholder="Password"
              placeholderTextColor={colors.mutedForeground}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
            />
            <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
              <Feather name={showPassword ? "eye-off" : "eye"} size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.primary, opacity: loginMutation.isPending ? 0.8 : 1 }]}
            onPress={handleLogin}
            disabled={loginMutation.isPending}
          >
            {loginMutation.isPending ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <>
                <Feather name="shield" size={16} color={colors.primaryForeground} />
                <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>ACCESS SYSTEM</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <Text style={[styles.footer, { color: colors.mutedForeground }]}>
          © Williams Council Security Group
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  glow: {
    position: "absolute",
    top: "20%",
    alignSelf: "center",
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: "#c9a84c",
    opacity: 0.07,
    transform: [{ scaleX: 1.6 }],
  },
  content: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    gap: 20,
  },
  logoWrap: {
    alignItems: "center",
  },
  logo: {
    width: 160,
    height: 160,
    borderRadius: 80,
  },
  brandBlock: {
    alignItems: "center",
    gap: 4,
  },
  brandName: {
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: 4,
  },
  brandSub: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 6,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    opacity: 0.5,
  },
  motto: {
    fontSize: 9,
    letterSpacing: 2,
    fontWeight: "600",
  },
  card: {
    padding: 22,
    borderRadius: 14,
    borderWidth: 1,
    gap: 14,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 3,
    textAlign: "center",
    marginBottom: 4,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 50,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    fontSize: 15,
  },
  button: {
    height: 50,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 8,
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  buttonText: {
    fontWeight: "800",
    fontSize: 14,
    letterSpacing: 2,
  },
  footer: {
    textAlign: "center",
    fontSize: 11,
    letterSpacing: 1,
  },
});
