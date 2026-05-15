import { Platform } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

const BIO_PREF_KEY = "wcsg.biometricEnabled";
const BIO_DECISION_KEY = "wcsg.biometricDecisionMade";

const supportsSecureStore = Platform.OS === "ios" || Platform.OS === "android";

async function readPref(key: string): Promise<string | null> {
  if (!supportsSecureStore) return null;
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}
async function writePref(key: string, value: string): Promise<void> {
  if (!supportsSecureStore) return;
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    // ignore
  }
}
async function deletePref(key: string): Promise<void> {
  if (!supportsSecureStore) return;
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // ignore
  }
}

export async function isBiometricAvailable(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const has = await LocalAuthentication.hasHardwareAsync();
    if (!has) return false;
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return enrolled;
  } catch {
    return false;
  }
}

export async function isBiometricEnabled(): Promise<boolean> {
  return (await readPref(BIO_PREF_KEY)) === "1";
}

export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  if (enabled) await writePref(BIO_PREF_KEY, "1");
  else await deletePref(BIO_PREF_KEY);
  await writePref(BIO_DECISION_KEY, "1");
}

export async function hasBiometricDecisionBeenMade(): Promise<boolean> {
  return (await readPref(BIO_DECISION_KEY)) === "1";
}

export async function clearBiometricDecision(): Promise<void> {
  await deletePref(BIO_DECISION_KEY);
  await deletePref(BIO_PREF_KEY);
}

/** Prompts for biometric. Returns true on success. */
export async function promptBiometric(reason = "Unlock SecureOps"): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      fallbackLabel: "Use password",
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
