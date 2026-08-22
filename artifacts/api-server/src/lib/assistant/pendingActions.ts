import { randomUUID } from "node:crypto";

/**
 * Store for actions that are staged but NOT yet executed, waiting on an
 * explicit human Approve click.
 *
 * Deliberately in-memory and short-lived. A pending action is a UI handshake
 * within one sitting, not a durable work item: if the server restarts, the
 * right outcome is "that expired, ask me again", never "an approval from
 * yesterday silently fires".
 *
 * Three properties matter and are enforced here:
 *   - single-use  — claiming removes it, so a double-click cannot double-apply.
 *   - expiring    — an unapproved action dies rather than lingering.
 *   - owned       — only the user it was staged for can approve it.
 */

export type PendingAction = {
  id: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Concrete, human-readable description of exactly what will change. */
  summary: string;
  /** Field-by-field detail rendered as a diff-style list in the UI. */
  details: Array<{ label: string; value: string }>;
  createdAt: number;
  expiresAt: number;
};

const TTL_MS = 10 * 60 * 1000;
const MAX_PER_USER = 5;

const store = new Map<string, PendingAction>();

function sweep(): void {
  const now = Date.now();
  for (const [id, a] of store) {
    if (a.expiresAt <= now) store.delete(id);
  }
}

export function stagePendingAction(input: {
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  details: Array<{ label: string; value: string }>;
}): PendingAction {
  sweep();
  // Keep one user from stacking up staged actions; oldest falls off.
  const mine = [...store.values()]
    .filter((a) => a.userId === input.userId)
    .sort((a, b) => a.createdAt - b.createdAt);
  while (mine.length >= MAX_PER_USER) {
    const oldest = mine.shift();
    if (oldest) store.delete(oldest.id);
  }

  const now = Date.now();
  const action: PendingAction = {
    id: randomUUID(),
    userId: input.userId,
    tool: input.tool,
    args: input.args,
    summary: input.summary,
    details: input.details,
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  store.set(action.id, action);
  return action;
}

export type ClaimResult =
  | { ok: true; action: PendingAction }
  | { ok: false; reason: "not_found" | "expired" | "not_yours" };

/**
 * Atomically take ownership of a pending action. Removing it up front is what
 * makes it single-use: a second click finds nothing and reports it plainly
 * instead of applying the change twice.
 */
export function claimPendingAction(id: string, userId: string): ClaimResult {
  sweep();
  const action = store.get(id);
  if (!action) return { ok: false, reason: "not_found" };
  if (action.userId !== userId) return { ok: false, reason: "not_yours" };
  store.delete(id);
  if (action.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, action };
}

export function discardPendingAction(id: string, userId: string): boolean {
  const action = store.get(id);
  if (!action || action.userId !== userId) return false;
  store.delete(id);
  return true;
}

/** Test helper — drops all staged actions. */
export function clearPendingActionsForTests(): void {
  store.clear();
}
