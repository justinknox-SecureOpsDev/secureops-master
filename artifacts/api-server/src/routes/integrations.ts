import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { requireAdmin } from "../middlewares/auth";
import { syncFromMonday, DEFAULT_BOARD_IDS, type SyncKind } from "../lib/mondaySync";

const router: IRouter = Router();

const syncBody = z.object({
  kind: z.enum(["employees", "clients", "sites", "onboarding", "candidates"]),
  boardId: z.string().regex(/^\d+$/, "boardId must be numeric").optional(),
  dryRun: z.boolean().default(true),
});

router.post("/admin/integrations/monday/sync", requireAdmin, async (req, res): Promise<void> => {
  const parsed = syncBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request", errors: parsed.error.issues });
    return;
  }
  if (!process.env.MONDAY_API_TOKEN) {
    res.status(503).json({ message: "MONDAY_API_TOKEN is not configured on the server" });
    return;
  }
  try {
    const result = await syncFromMonday(parsed.data as { kind: SyncKind; boardId?: string; dryRun: boolean });
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    req.log.error({ err: msg }, "monday sync failed");
    res.status(502).json({ message: msg });
  }
});

router.get("/admin/integrations/monday/status", requireAdmin, (_req, res): void => {
  res.json({ configured: Boolean(process.env.MONDAY_API_TOKEN), defaults: DEFAULT_BOARD_IDS });
});

export default router;
