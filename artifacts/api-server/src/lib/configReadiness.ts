/**
 * Boot-time config readiness signal.
 *
 * The API server opens its port (`server.listen`) immediately so health checks
 * and clients aren't blocked. The super-admin brand + feature-flag overrides,
 * however, are loaded from the DB asynchronously. Without coordination, the
 * very first `GET /api/brand` after a redeploy can race ahead of that load and
 * return the env baseline — e.g. a stale white-label placeholder company name
 * instead of the tenant's real name. The admin portal caches whatever it
 * fetches first for the whole session, so the placeholder then sticks until a
 * hard refresh.
 *
 * This module exposes a single readiness promise. `initConfigReadiness()` kicks
 * off the brand + feature override loads at boot; `whenConfigReady()` is awaited
 * by `GET /api/brand` so its first response already reflects DB overrides. The
 * signal resolves as soon as the loads finish OR after a short timeout, so a
 * slow / unavailable database can never hang the endpoint or startup — it just
 * falls back to the current env values until the load eventually completes.
 */
import { loadBrandOverridesFromDb } from "./brandConfig";
import { loadFeatureOverridesFromDb } from "./features";
import { loadPermissionOverridesFromDb } from "./permissions";
import { logger } from "./logger";

/**
 * How long `/api/brand` will wait for the DB override loads before falling back
 * to the env baseline. Kept short so the endpoint (and any health check that
 * happens to hit it) never hangs if the database is briefly slow at boot; the
 * loads keep running in the background and later requests pick up the real
 * values once they finish.
 */
const CONFIG_READY_TIMEOUT_MS = 3000;

let readyPromise: Promise<void> | null = null;

/**
 * Run the super-admin brand + feature-flag override loads, preserving the
 * per-load boot logging. Both loaders swallow their own errors (missing table
 * pre-`db push`, transient DB blip) and resolve, so this never rejects.
 */
function loadConfigOverrides(): Promise<void> {
  return Promise.allSettled([
    loadBrandOverridesFromDb()
      .then(() => logger.info("Brand overrides loaded"))
      .catch((err) => logger.error({ err }, "Failed to load brand overrides")),
    loadFeatureOverridesFromDb()
      .then(() => logger.info("Feature-flag overrides loaded"))
      .catch((err) => logger.error({ err }, "Failed to load feature-flag overrides")),
    loadPermissionOverridesFromDb()
      .then(() => logger.info("Permission overrides loaded"))
      .catch((err) => logger.error({ err }, "Failed to load permission overrides")),
    // NOTE: the one-time company-owner rollout backfill is intentionally NOT
    // run here. It must fire only after initial/demo admin provisioning has
    // completed (see index.ts, chained after `demoUsersSeeded`) — running it
    // in this parallel, boot-time batch could claim its one-time marker
    // before any admin exists on a fresh database, permanently excluding the
    // very first admin from ever being auto-granted ownership.
  ]).then(() => undefined);
}

/**
 * Kick off the brand + feature-flag override loads and build the readiness
 * signal. Call once at boot. Non-blocking: returns immediately so the caller
 * can open the port without waiting on the database. Idempotent — repeated
 * calls return the same promise.
 */
export function initConfigReadiness(): Promise<void> {
  if (readyPromise) return readyPromise;

  const loads = loadConfigOverrides();

  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn(
        { timeoutMs: CONFIG_READY_TIMEOUT_MS },
        "Config overrides slow to load at boot — /api/brand will serve env baseline until they complete",
      );
      resolve();
    }, CONFIG_READY_TIMEOUT_MS);
    // Never let the fallback timer keep the event loop (or graceful shutdown)
    // alive on its own.
    timer.unref();
  });

  readyPromise = Promise.race([loads, timeout]);
  return readyPromise;
}

/**
 * Await the config readiness signal. Resolves once the DB overrides are loaded
 * (or the boot timeout elapses). Returns an already-resolved promise if the
 * signal was never initialised (e.g. unit tests that import the app without
 * booting the server), so callers never hang.
 */
export function whenConfigReady(): Promise<void> {
  return readyPromise ?? Promise.resolve();
}

/**
 * Test-only: replace the readiness promise (pass `null` to simulate a
 * not-yet-booted server). Lets suites drive the boot-window ordering
 * deterministically. Never called from production code.
 */
export function __setConfigReadinessForTests(promise: Promise<void> | null): void {
  readyPromise = promise;
}
