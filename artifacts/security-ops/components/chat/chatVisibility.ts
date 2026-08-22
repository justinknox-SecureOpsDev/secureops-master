/**
 * Pure predicate for whether ChatRoomsList's Secure Ops AI Bot preview row
 * should render. The bot is a private, one-on-one surface reached from the
 * room list — it never becomes a member of a shared chat_rooms thread — so
 * it renders as its own fixed row above the tabs, gated on:
 *   - the "assistant" feature flag actually being on for this tenant, and
 *   - the caller having wired up somewhere to open it (`onOpenAiBot`); a
 *     standalone usage with no bot route omits it, and the row must not
 *     become a dead tap target.
 */
export function shouldShowAiBotEntry(
  assistantEnabled: boolean,
  onOpenAiBot: (() => void) | undefined,
): boolean {
  return assistantEnabled && !!onOpenAiBot;
}
