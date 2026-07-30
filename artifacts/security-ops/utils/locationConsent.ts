// Decision logic for "may we read this device's location right now?".
//
// Kept in its own react-native-free module on purpose: the vitest setup cannot
// parse react-native's `import typeof` syntax, so anything that pulls in the
// native chain is untestable. See .agents/memory/vitest-rn-import-parse-error.md.
//
// The rule this encodes comes from Google Play's User Data policy (Prominent
// Disclosure). On Android the user must see an in-app disclosure and take an
// affirmative action BEFORE the OS permission dialog appears. iOS deliberately
// skips the disclosure: Apple has rejected this app twice under Guideline
// 5.1.1(iv) for putting a custom screen in front of an OS permission prompt.

export type LocationPermissionStatus = "granted" | "denied" | "undetermined" | string;

export type LocationGateDeps = {
  /** Platform.OS */
  platform: string;
  /**
   * When true, never show UI. Returns true only if the disclosure was already
   * accepted AND the OS permission is already granted. Used by the panic-alert
   * path (must not block) and the on-shift ping (no user gesture behind it).
   */
  silent: boolean;
  hasAccepted: () => Promise<boolean>;
  recordAccepted: () => Promise<void>;
  /** Shows the disclosure; resolves true when the user affirmatively agrees. */
  askForConsent: () => Promise<boolean>;
  /** Reads the current OS permission WITHOUT prompting. */
  getCurrentStatus: () => Promise<LocationPermissionStatus>;
  /** Triggers the OS permission prompt. */
  requestPermission: () => Promise<LocationPermissionStatus>;
};

export async function resolveLocationAccess(deps: LocationGateDeps): Promise<boolean> {
  const {
    platform,
    silent,
    hasAccepted,
    recordAccepted,
    askForConsent,
    getCurrentStatus,
    requestPermission,
  } = deps;

  if (platform === "android") {
    if (!(await hasAccepted())) {
      // No disclosure shown yet. In silent mode we must not collect and must
      // not pop UI, so the caller simply goes without location.
      if (silent) return false;
      const agreed = await askForConsent();
      if (!agreed) return false;
      await recordAccepted();
    }
  }

  if (silent) return (await getCurrentStatus()) === "granted";
  return (await requestPermission()) === "granted";
}
