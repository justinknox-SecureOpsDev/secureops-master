import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

function ok(_req: unknown, res: { json: (b: unknown) => void }) {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
}

// /api/healthz — explicit health probe used by load balancer / uptime monitor.
router.get("/healthz", ok);

// /api and /api/ — root probe. Some uptime monitors hit the service base path
// (no sub-route) and were getting 404s, which counted as downtime during
// autoscale cold starts. Return 200 here so the monitor treats the service
// as healthy as soon as the process is accepting connections.
router.get("/", ok);

export default router;
