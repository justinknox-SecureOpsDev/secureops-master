process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ?? "test-session-secret-at-least-16-chars-long";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";

process.on("unhandledRejection", (err) => {
  // eslint-disable-next-line no-console
  console.error("[test] unhandledRejection:", err);
});

process.env.PORT = process.env.PORT ?? "0";

// Share-link minting refuses to run without a trusted origin (no
// Host-header fallback). Set a known value so the incident-share tests
// can mint URLs deterministically.
process.env.APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:8080";
