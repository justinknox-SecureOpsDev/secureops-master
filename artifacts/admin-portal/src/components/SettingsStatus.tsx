/**
 * Presentational bits shared by the admin settings surfaces so that a failed
 * read is never drawn like "nothing is stored", and a failed write is always
 * reported next to the control that failed.
 *
 * See `@/lib/settingsStatus` and `.agents/memory/unknown-vs-empty-ui-state.md`.
 */
import { Loader2 } from "lucide-react";
import type { SettingsMessage } from "@/lib/settingsStatus";

/**
 * Explicit "couldn't read this" state with a retry — shown *instead of* the
 * built-in defaults, so an unreachable API can't masquerade as an unconfigured
 * setting.
 */
export function LoadFailedNotice({
  label,
  hasLastKnown,
  onRetry,
  retrying,
  message,
}: {
  /** Plain-language name of the thing that couldn't be read, e.g. "branding". */
  label: string;
  /** True when a previous read succeeded and its values are still on screen. */
  hasLastKnown: boolean;
  onRetry: () => void;
  retrying?: boolean;
  /**
   * Override the default "Couldn't load the {label} settings" lead sentence.
   * For surfaces that aren't a settings page (e.g. a list, or a background
   * refetch after a write rather than the initial read), the generic
   * "settings" wording doesn't fit — pass the exact sentence instead. The
   * `hasLastKnown` follow-up sentence is still appended automatically.
   */
  message?: string;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <span>
        {message ?? `Couldn't load the ${label} settings — the server didn't respond.`}
        {hasLastKnown
          ? " Showing the last values this page read; they may be out of date."
          : " Nothing is shown below rather than the built-in defaults, which would look like an empty setting."}
      </span>
      <button
        type="button"
        className="inline-flex items-center font-medium underline underline-offset-2"
        onClick={onRetry}
        disabled={retrying}
      >
        {retrying && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        Try again
      </button>
    </div>
  );
}

/** "Still reading" — distinct from both "failed" and "nothing stored". */
export function LoadingNotice({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm opacity-70">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading the {label} settings…
    </p>
  );
}

/** Result of a save, rendered inline beside the button that triggered it. */
export function ControlMessage({ message }: { message: SettingsMessage | null }) {
  if (!message) return null;
  const tone =
    message.kind === "error"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : message.kind === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-900"
        : "border-emerald-300 bg-emerald-50 text-emerald-700";
  return (
    <p
      role={message.kind === "ok" ? "status" : "alert"}
      className={`rounded-md border px-2.5 py-1.5 text-xs ${tone}`}
    >
      {message.text}
    </p>
  );
}
