// Vitest globalSetup. The default export runs once before any test
// file; the returned function runs once after all of them. We use it
// only to close the shared pg pool so the worker process can exit
// cleanly after multiple test files have shared the singleton.
export default async function setup(): Promise<() => Promise<void>> {
  return async () => {
    const { pool } = await import("@workspace/db");
    await pool.end().catch(() => undefined);
  };
}
