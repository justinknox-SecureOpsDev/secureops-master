import { Router, type IRouter, type Request, type Response } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { BUILD_VERSION, BUILD_TIME } from "../lib/buildInfo";

const router: IRouter = Router();

function ok(_req: unknown, res: { json: (b: unknown) => void }) {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
}

// /api/healthz — explicit health probe used by load balancer / uptime monitor.
router.get("/healthz", ok);

// /api/version — public, unauthenticated build-identity probe. The control
// plane polls this to track which version each customer backend is running and
// to flag deployments that are behind the fleet target. Deliberately public
// (no secret): the version string + build time are non-sensitive, and uptime
// monitors must be able to read it without credentials. Backward-compatible —
// a brand-new field, no change to /healthz.
router.get("/version", (_req: Request, res: Response) => {
  res.json({ status: "ok", version: BUILD_VERSION, builtAt: BUILD_TIME });
});

// /api and /api/ — root probe. Some uptime monitors hit the service base path
// (no sub-route) and were getting 404s, which counted as downtime during
// autoscale cold starts. Return 200 here so the monitor treats the service
// as healthy as soon as the process is accepting connections.
router.get("/", ok);

export default router;
