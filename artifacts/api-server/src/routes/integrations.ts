import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { requireAdmin } from "../middlewares/auth";
import { syncFromMonday } from "../lib/mondaySync";

const router: IRouter = Router();

const syncBody = z.object({
  boardId: z.string().regex(/^\d+$/, "boardId must be numeric"),
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
    const result = await syncFromMonday(parsed.data);
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    req.log.error({ err: msg }, "monday sync failed");
    res.status(502).json({ message: msg });
  }
});

router.get("/admin/integrations/monday/status", requireAdmin, (_req, res): void => {
  res.json({ configured: Boolean(process.env.MONDAY_API_TOKEN) });
});

export default router;
