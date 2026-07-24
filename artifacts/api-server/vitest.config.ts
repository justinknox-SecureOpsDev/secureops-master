import { defineConfig } from "vitest/config";

// ─────────────────────────────────────────────────────────────────────────────
// Test-authoring invariants — read before adding a new test file
// ─────────────────────────────────────────────────────────────────────────────
//
// EXECUTION MODEL
//   All files run in a single OS process (singleFork) and are scheduled one at
//   a time (fileParallelism: false).  This eliminates inter-process connection
//   churn and prevents concurrent-write races (e.g. the 23505 invoice-upsert
//   and chat/dispatch timeout flakes that were reproducible under parallel
//   scheduling).  Do NOT change these settings without re-running the full
//   suite multiple times — races may be rare but real.
//
// RULE 1 — TAG EVERY ROW YOU INSERT
//   Generate a suite-unique prefix at module load time:
//
//     const TAG = `my-suite-${randomUUID().slice(0, 8)}`;
//
//   Embed TAG in a discriminating column (email, lastName, name, etc.) for
//   every row you create.  Your afterAll cleanup then uses a WHERE clause
//   scoped to TAG so it never touches rows belonging to other suites or to the
//   real seed data.  Example:
//
//     afterAll(async () => {
//       await db.execute(sql`DELETE FROM applications WHERE last_name = ${TAG}`);
//       await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
//     });
//
// RULE 2 — SNAPSHOT + RESTORE GLOBAL SINGLETON TABLES
//   Some tables have no per-row tenancy key (e.g. `application_questions`,
//   `platform_settings`).  Because files run serially there is no concurrent
//   race, but another suite running BEFORE yours may have left different
//   contents than the seed baseline.  If your suite reads or asserts on the
//   full contents of such a table, snapshot its pre-existing rows in beforeAll,
//   wipe, run, then restore in afterAll:
//
//     let saved: Row[] = [];
//
//     beforeAll(async () => {
//       saved = await db.select().from(singletonTable);
//       await db.delete(singletonTable);
//     });
//
//     afterEach(async () => {
//       await db.delete(singletonTable);      // clean between tests
//     });
//
//     afterAll(async () => {
//       await db.delete(singletonTable);
//       if (saved.length > 0) {
//         await db.insert(singletonTable).values(saved);
//       }
//     });
//
//   Reference implementation: src/__tests__/applicationCustomQuestions.test.ts
//
// RULE 3 — NO CROSS-FILE STATE ASSUMPTIONS
//   Never assume that a row created by a different test file is (or is not)
//   present.  Serial scheduling preserves run order but every suite is
//   responsible for its own setup and teardown.  If your test needs a specific
//   DB state, create it in beforeAll / beforeEach and delete it in afterAll /
//   afterEach.
//
// RULE 4 — NEVER COUNT ROWS IN SHARED TABLES WITHOUT FILTERING BY TAG
//   A previous suite may have left rows behind (bug or crash before afterAll).
//   Always filter by your own TAG or by a FK to your own test users/clients/
//   sites rather than asserting on total row counts of shared tables.
//
// RULE 5 — DO NOT CLOSE THE DB POOL INSIDE A TEST FILE
//   The shared pool is closed exactly once by globalTeardown.ts after all files
//   finish.  Closing it early from within a test file will cause every
//   subsequent suite to fail with "connection pool has ended".
//
// RULE 6 — WATCH FOR HARDCODED CALENDAR DATES
//   Tests that compare against hardcoded ISO date literals (e.g. "2025-01-01")
//   to stand in for "future" or "past" become time-bombs once real time passes
//   that date.  Always derive relative dates at runtime:
//
//     const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
//       .toISOString().slice(0, 10);
//
//   See memory entry "Scheduler sync test date time-bomb" for a known example.
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 60 s per test / hook — heavier DB suites (chatMembershipLifecycle,
    // dispatch, adminGridTimeEntryInvoiceSync) need the extra headroom when
    // running after many other suites in the same process.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["src/__tests__/setup.ts"],
    globalSetup: ["src/__tests__/globalTeardown.ts"],
    // Run all test files in a single child process AND sequentially.
    //
    // singleFork   — keeps everything in one fork so there is no inter-process
    //                DB connection explosion.
    // fileParallelism: false — prevents vitest from scheduling multiple files
    //                concurrently inside that fork, which was the real source
    //                of the 23505 invoice-upsert races and the chat/dispatch
    //                timeout flakes under full-suite load.
    pool: "forks",
    forks: { singleFork: true },
    fileParallelism: false,
  },
});
