import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const overrideUrl = process.env.OVERRIDE_DATABASE_URL;
const connectionString = overrideUrl ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}
const dbHostHint = connectionString.replace(/.*@/, "").split("/")[0]?.split(".")[0] ?? "unknown";
console.log(`[db] using ${overrideUrl ? "OVERRIDE_DATABASE_URL" : "DATABASE_URL"} (host=${dbHostHint})`);

export const pool = new Pool({ connectionString });

// Neon (serverless Postgres) routinely closes idle connections — e.g. when the
// compute auto-suspends/scales down — which surfaces as a FATAL error (code
// 57P01, "terminating connection due to administrator command") on an idle
// pooled client. node-postgres re-emits that as an 'error' event on the Pool;
// with no listener attached, Node escalates it to an uncaughtException and the
// whole process dies. This is expected, recoverable behavior: the pool simply
// discards the dead client and opens a fresh one on the next query. So we log
// it and move on — never let it take the server down.
pool.on("error", (err) => {
  // 57P01 = admin-initiated termination (Neon idle/auto-suspend). 57P02/57P03
  // (crash shutdown / cannot connect now) and ECONNRESET are the same class of
  // expected, transient connectivity blips. Log these quietly; the pool
  // recovers on its own. Anything else is unexpected and gets logged loudly so
  // it can be alerted on — but we still never crash the process.
  const code = (err as NodeJS.ErrnoException).code;
  const expected = code === "57P01" || code === "57P02" || code === "57P03" || code === "ECONNRESET";
  if (expected) {
    console.warn(`[db] idle client connection dropped (recoverable, code=${code}): ${err.message}`);
  } else {
    console.error(`[db] unexpected pool error (code=${code ?? "none"}): ${err.message}`);
  }
});

export const db = drizzle(pool, { schema });

export * from "./schema";
export { seedPolicies, DEFAULT_POLICY_SLUGS, backfillEmployeeProfileFields } from "./seed";
