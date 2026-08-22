/**
 * A background refetch failing must never look like the viewer's own owner
 * access was just revoked.
 *
 * `CompanyOwners.tsx` had a single `if (q.isError)` branch that rendered
 * "Owner access required" for BOTH a genuine 403 (not an owner) and any
 * other read failure — including the invalidateQueries refetch the toggle
 * mutation fires on success. A transient network blip right after a
 * confirmed toggle therefore told the admin they had lost access, even
 * though the toast had just confirmed the write succeeded and no data was
 * lost.
 *
 * Contract pinned here:
 *   - a 403 renders the "Owner access required" permission message;
 *   - any other read failure renders a distinct "couldn't refresh/load"
 *     notice with a retry, never the permission message;
 *   - a failed refetch with last-known rows keeps the table on screen with
 *     a small inline notice instead of blanking it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "admin1", role: "admin", isCompanyOwner: true } }),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

import { api, ApiError } from "@/lib/api";
import CompanyOwnersPage from "@/pages/CompanyOwners";

const apiMock = vi.mocked(api);

const OWNERS = {
  users: [
    { id: "admin1", email: "owner@example.com", firstName: "Ada", lastName: "Owner", role: "admin", status: "active", isCompanyOwner: true },
  ],
  ownerCount: 1,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CompanyOwnersPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Company owners read-failure reporting", () => {
  it("shows the permission message on a genuine 403", async () => {
    apiMock.mockRejectedValue(new ApiError(403, "Company owner access required"));
    renderPage();

    await waitFor(() => expect(screen.getByText(/Owner access required/i)).toBeTruthy());
    expect(screen.queryByText(/Couldn't load/i)).toBeNull();
    expect(screen.queryByText(/Couldn't refresh/i)).toBeNull();
  });

  it("shows a distinct retry notice (not the permission message) on a network/5xx failure with no data yet", async () => {
    apiMock.mockRejectedValue(new ApiError(503, "The server is temporarily unreachable."));
    renderPage();

    await waitFor(() => expect(screen.getByText(/Couldn't load the company owners list/i)).toBeTruthy());
    expect(screen.queryByText(/Owner access required/i)).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("keeps the last-known rows visible with a small notice when a background refetch fails", async () => {
    let calls = 0;
    apiMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return OWNERS;
      throw new Error("Failed to fetch");
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CompanyOwnersPage />
      </QueryClientProvider>,
    );

    // Initial load succeeds — table is visible.
    expect(await screen.findByText("owner@example.com")).toBeTruthy();

    // A later background refetch (e.g. the mutation's invalidateQueries)
    // fails: the row must stay on screen, not swap to the permission page.
    await qc.refetchQueries({ queryKey: ["admin", "company-owners"] });

    await waitFor(() => expect(screen.getByText(/Couldn't refresh the owners list/i)).toBeTruthy());
    expect(screen.getByText("owner@example.com")).toBeTruthy();
    expect(screen.queryByText(/Owner access required/i)).toBeNull();
  });
});
