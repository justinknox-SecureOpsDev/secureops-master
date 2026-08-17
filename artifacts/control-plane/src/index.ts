import app from "./app";
import { DATABASE_URL, IS_PROD, PORT } from "./config";
import { ensureSchema, seedInitialCustomers } from "./db";
import { logger } from "./logger";
import { startPoller } from "./poller";
import { startRetention } from "./retention";

async function main(): Promise<void> {
  if (!DATABASE_URL) {
    if (IS_PROD) {
      throw new Error("[control-plane] CONTROL_PLANE_DATABASE_URL (or DATABASE_URL) is required.");
    }
    logger.warn("[control-plane] no database URL set — registry features will fail until configured");
  } else {
    await ensureSchema();
    await seedInitialCustomers();
    startPoller();
    startRetention();
  }

  app.listen(PORT, "0.0.0.0", () => {
    logger.info({ port: PORT, env: IS_PROD ? "production" : "development" }, "[control-plane] listening");
  });
}

main().catch((err) => {
  logger.error({ err: String(err) }, "[control-plane] fatal boot error");
  process.exit(1);
});
