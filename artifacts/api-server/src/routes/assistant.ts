import { Router, type IRouter } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireStaff } from "../middlewares/auth";
import { requireFeature } from "../lib/features";
import { isAssistantConfigured, isServiceUnavailable } from "../lib/assistant/gemini";
import { runAssistantTurn, type ChatHistoryTurn } from "../lib/assistant/agent";
import { computeFindings, dismissFinding } from "../lib/assistant/signals";
import { claimPendingAction, discardPendingAction } from "../lib/assistant/pendingActions";
import { executeAction, prepareAction } from "../lib/assistant/tools";
import { logger } from "../lib/logger";

/**
 * Portal assistant.
 *
 * Everything here is gated on `requireStaff` — client-portal accounts are
 * external contacts and must never reach it (a bare `requireAuth` would let
 * them in). The assistant then acts strictly as the signed-in user: its
 * actions go back through this same server's own routes carrying the caller's
 * token, so no endpoint here is a privileged shortcut.
 */

const router: IRouter = Router();

router.use("/assistant", requireFeature("assistant"));

/** Model calls cost money and latency; keep one account from hammering them. */
const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Per-account first (the assistant is staff-only, so a user id always
  // exists by the time this runs); the IP fallback must go through
  // ipKeyGenerator so IPv6 clients can't sidestep the bucket per address.
  keyGenerator: (req) => (req.user?.userId ? `as:u:${req.user.userId}` : `as:ip:${ipKeyGenerator(req.ip ?? "")}`),
  message: { error: "Too Many Requests", message: "Slow down a moment — too many assistant requests." },
});

function authHeader(req: { headers: Record<string, unknown> }): string | null {
  const raw = req.headers["authorization"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

// Whether the assistant is usable on this deployment. Lets the portal render
// an honest "not connected" panel instead of a generic error on first message.
router.get("/assistant/status", requireStaff, (_req, res) => {
  res.json({ configured: isAssistantConfigured() });
});

router.post("/assistant/chat", requireStaff, chatLimiter, async (req, res): Promise<void> => {
  const { message, history } = req.body ?? {};
  if (typeof message !== "string" || message.trim() === "") {
    res.status(400).json({ error: "Bad Request", message: "A message is required." });
    return;
  }
  const auth = authHeader(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized", message: "Missing credentials." });
    return;
  }

  const cleanHistory: ChatHistoryTurn[] = Array.isArray(history)
    ? history
        .filter(
          (t: unknown): t is ChatHistoryTurn =>
            typeof t === "object" &&
            t !== null &&
            typeof (t as ChatHistoryTurn).content === "string" &&
            ((t as ChatHistoryTurn).role === "user" || (t as ChatHistoryTurn).role === "assistant"),
        )
        .slice(-12)
    : [];

  try {
    const reply = await runAssistantTurn({
      ctx: {
        user: { userId: req.user!.userId, role: req.user!.role, email: req.user!.email },
        authorization: auth,
        originRef: `assistant:${req.user!.userId}:${Date.now()}`,
      },
      message,
      history: cleanHistory,
    });
    res.json(reply);
  } catch (err) {
    if (isServiceUnavailable(err)) {
      res.status(503).json({
        error: "Service Unavailable",
        message:
          "The AI assistant is not connected on this deployment. An operator needs to connect Gemini in the Replit AI Integrations pane.",
      });
      return;
    }
    logger.error({ err }, "[assistant] chat failed");
    res.status(500).json({ error: "Internal Server Error", message: "The assistant could not answer just then." });
  }
});

// Run a staged action after the human has explicitly approved it.
router.post("/assistant/actions/:id/approve", requireStaff, async (req, res): Promise<void> => {
  const id = String(req.params["id"] ?? "");
  const auth = authHeader(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized", message: "Missing credentials." });
    return;
  }

  const claim = claimPendingAction(id, req.user!.userId);
  if (!claim.ok) {
    const message =
      claim.reason === "expired"
        ? "That request expired before it was approved. Nothing was changed — ask again if you still want it."
        : "That request is no longer waiting for approval. Nothing was changed.";
    res.status(claim.reason === "expired" ? 410 : 404).json({ error: "Not Found", message });
    return;
  }

  // Re-validate rather than trusting the staged args blindly: the world may
  // have moved on since the card was rendered, and the underlying route is
  // the final authority either way.
  const ctx = {
    user: { userId: req.user!.userId, role: req.user!.role, email: req.user!.email },
    authorization: auth,
    originRef: `assistant-approved:${req.user!.userId}:${claim.action.id}`,
    // One approval, one key. Derived from the claimed action rather than
    // minted per send, so if the dispatch is interrupted the re-send is
    // recognised as the SAME write and replays its outcome instead of
    // applying it twice.
    idempotencyKey: `assistant-action:${claim.action.id}`,
  };

  const prepared = await prepareAction(ctx, claim.action.tool, claim.action.args);
  if ("error" in prepared) {
    res.status(400).json({ error: "Bad Request", message: prepared.error });
    return;
  }

  const outcome = await executeAction(ctx, prepared);

  if (!outcome.ok) {
    // An unknown outcome is not a failure — the write may have landed. Say so
    // plainly rather than letting the portal draw a red "did not happen" card.
    // Reaching here means even the re-send under the same idempotency key came
    // back without an answer, so "I don't know" is still the honest report.
    if (outcome.unconfirmed) {
      res.status(504).json({ error: "Unconfirmed", unconfirmed: true, message: outcome.message });
      return;
    }
    res.status(outcome.status >= 400 && outcome.status < 600 ? outcome.status : 400).json({
      error: "Action Failed",
      message: outcome.message,
      ...(outcome.reconciled ? { reconciled: true } : {}),
    });
    return;
  }
  res.json({
    ok: true,
    summary: prepared.summary,
    result: outcome.result ?? {},
    // Only present when the first dispatch was interrupted. The person watched
    // the button spin, so tell them what actually happened rather than leaving
    // an ordinary "Done" over a re-sent write.
    ...(outcome.reconciled ? { reconciled: true, note: outcome.message } : {}),
  });
});

router.post("/assistant/actions/:id/discard", requireStaff, (req, res) => {
  const removed = discardPendingAction(String(req.params["id"] ?? ""), req.user!.userId);
  res.json({ ok: removed });
});

// Adoption suggestions. Deliberately independent of Gemini — the findings are
// computed from the account's own data, so this keeps working (and stays
// useful) on a deployment where the AI integration is not connected.
router.get("/assistant/suggestions", requireStaff, async (req, res): Promise<void> => {
  try {
    const findings = await computeFindings({ userId: req.user!.userId, role: req.user!.role });
    res.json({ findings });
  } catch (err) {
    logger.error({ err }, "[assistant] suggestions failed");
    res.status(500).json({ error: "Internal Server Error", message: "Could not work out suggestions just now." });
  }
});

router.post("/assistant/suggestions/:id/dismiss", requireStaff, async (req, res): Promise<void> => {
  const findingId = String(req.params["id"] ?? "");
  if (!findingId) {
    res.status(400).json({ error: "Bad Request", message: "A suggestion id is required." });
    return;
  }
  const permanent = req.body?.permanent === true;
  await dismissFinding(req.user!.userId, findingId, permanent);
  res.json({ ok: true });
});

export default router;
