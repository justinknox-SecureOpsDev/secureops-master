/**
 * Remote-change retention pruning.
 *
 * `pruneRemoteChangesOnce` trims the audit trail so it does not grow forever.
 * These tests pin two contracts:
 *   - a non-positive retention window disables pruning (no DELETE issued);
 *   - a positive window issues an idempotent age-based DELETE and reports the
 *     number of rows removed.
 *
 * The pg pool is stubbed so the test is self-contained (no live DB).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  pool: { query: vi.fn() },
}));

const { pool } = await import("../db");
const { pruneRemoteChangesOnce } = await import("../retention");
const queryMock = pool.query as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  queryMock.mockReset();
});

describe("pruneRemoteChangesOnce", () => {
  it("does not issue a DELETE when the window is non-positive", async () => {
    const deleted = await pruneRemoteChangesOnce(0);
    expect(deleted).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("does not issue a DELETE for a negative window", async () => {
    const deleted = await pruneRemoteChangesOnce(-5);
    expect(deleted).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("deletes rows older than the window and returns the count", async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 7 });
    const deleted = await pruneRemoteChangesOnce(180);
    expect(deleted).toBe(7);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM control_plane_remote_changes/i);
    expect(sql).toMatch(/created_at < now\(\)/i);
    expect(params).toEqual(["180"]);
  });

  it("treats a null rowCount as zero", async () => {
    queryMock.mockResolvedValueOnce({ rowCount: null });
    const deleted = await pruneRemoteChangesOnce(30);
    expect(deleted).toBe(0);
  });
});
