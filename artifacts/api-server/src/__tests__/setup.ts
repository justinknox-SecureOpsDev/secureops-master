process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ?? "test-session-secret-at-least-16-chars-long";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";

process.on("unhandledRejection", (err) => {
  // eslint-disable-next-line no-console
  console.error("[test] unhandledRejection:", err);
});

process.env.PORT = process.env.PORT ?? "0";
