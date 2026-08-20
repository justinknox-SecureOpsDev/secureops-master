/**
 * Shared vocabulary for admin *settings* surfaces — the pages that render
 * "your stored value, otherwise the built-in default".
 *
 * See `.agents/memory/unknown-vs-empty-ui-state.md`. The rules these helpers
 * exist to support:
 *
 *  1. A failed read must never be drawn as "nothing is stored". Keep the last
 *     known value and label the failure, with a retry.
 *  2. The write response is authoritative: apply it locally *before* the
 *     confirmation refresh, so a failing refresh can't undo a good save.
 *  3. Report the failure next to the control that failed — on a phone the
 *     cards stack and a page-top banner is scrolled far off-screen.
 *  4. Never guess the outcome of a write that didn't answer cleanly.
 */
import { ApiError } from "@/lib/api";

/** A short-lived result message rendered next to the control that produced it. */
export type SettingsMessage = {
  /** error = definitely/possibly not saved · warn = saved but unverified · ok = confirmed */
  kind: "error" | "warn" | "ok";
  text: string;
};

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "Unknown error";
}

/**
 * Whether the server itself refused the write, in which case nothing was
 * stored and we may say so.
 *
 * Only a 4xx proves refusal. A 5xx can come from a proxy *after* the server
 * committed, and a non-`ApiError` means no answer came back at all (dropped
 * connection, restart mid-request) — both are "unknown", never "not saved".
 */
export function writeWasRefused(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500;
}
