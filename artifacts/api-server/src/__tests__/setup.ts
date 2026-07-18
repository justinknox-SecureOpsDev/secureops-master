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

// The public POST /applications limiter defaults to 5/IP/hour. Tests run
// from a single source IP (127.0.0.1) and several suites submit real
// applications, which would otherwise trip the limiter and flake. Lift the
// cap in the test env only.
process.env.APPLICATION_SUBMIT_RATE_LIMIT_MAX =
  process.env.APPLICATION_SUBMIT_RATE_LIMIT_MAX ?? "1000";
