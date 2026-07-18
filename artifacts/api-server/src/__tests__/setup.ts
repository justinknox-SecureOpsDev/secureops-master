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

// The public GET /org-directory/resolve limiter defaults to 60/IP/5min. The
// dedicated rate-limit test in orgDirectory.test.ts needs to drive the endpoint
// PAST its cap deterministically without firing 60+ requests, so lower the cap
// in the test env. The functional org-directory tests isolate their own per-IP
// buckets (distinct X-Forwarded-For per request) so this low cap never trips
// them.
process.env.ORG_DIRECTORY_RATE_LIMIT_MAX =
  process.env.ORG_DIRECTORY_RATE_LIMIT_MAX ?? "10";
