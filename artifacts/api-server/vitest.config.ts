import { defineConfig } from "vitest/config";

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
