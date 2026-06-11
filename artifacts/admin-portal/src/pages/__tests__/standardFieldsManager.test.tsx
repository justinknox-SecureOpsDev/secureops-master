import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

/**
 * Regression coverage for the form-builder's Standard fields manager
 * (`StandardFieldsManager`, rendered inside `ApplicationBuilderPage`).
 *
 * The locked core fields (firstName, lastName, email, phone, address) are
 * always required + visible — the server silently drops any attempt to relax
 * them. The UI must mirror that: the Required and "Visible on form" toggles are
 * disabled for locked fields and enabled for everyone else. This pins the
 * client side of the architect-flagged payload contract so the two can't drift.
 *
 * Only `@/lib/api` is stubbed; the real page + manager are mounted so the
 * effective-field fetch, section grouping, and edit-form wiring are exercised
 * together.
 */

type EffectiveField = {
  key: string;
  section: number;
  label: string;
  helpText: string | null;
  required: boolean;
  hidden: boolean;
  sortOrder: number;
  locked: boolean;
};

const hoisted = vi.hoisted(() => ({
  fields: [] as EffectiveField[],
}));

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string) => {
    if (path.startsWith("/admin/application-fields")) return hoisted.fields;
    if (path.startsWith("/admin/application-questions")) return [];
    return [];
  }),
  ApiError: class ApiError extends Error {},
}));

import { ApplicationBuilderPage } from "@/pages/ApplicationBuilder";

function field(partial: Partial<EffectiveField> & Pick<EffectiveField, "key" | "label" | "locked">): EffectiveField {
  return {
    section: 0,
    helpText: null,
    required: true,
    hidden: false,
    sortOrder: 0,
    ...partial,
  };
}

beforeEach(() => {
  hoisted.fields = [
    field({ key: "firstName", label: "First name", locked: true, sortOrder: 0 }),
    field({ key: "city", label: "City", locked: false, sortOrder: 1 }),
  ];
});

async function openEditor(fieldLabel: string) {
  render(<ApplicationBuilderPage />);
  const editBtn = await screen.findByRole("button", { name: `Edit "${fieldLabel}"` });
  fireEvent.click(editBtn);
  // The editor inputs appear once edit mode is on.
  await screen.findByLabelText("Required");
}

describe("StandardFieldsManager — locked field toggles", () => {
  it("disables Required and Visible toggles for a locked core field", async () => {
    await openEditor("First name");

    const required = screen.getByLabelText("Required") as HTMLInputElement;
    const visible = screen.getByLabelText("Visible on form") as HTMLInputElement;
    expect(required.disabled).toBe(true);
    expect(visible.disabled).toBe(true);
    // Locked fields read as required + visible.
    expect(required.checked).toBe(true);
    expect(visible.checked).toBe(true);
    // The explanatory helper text is shown.
    expect(screen.getByText(/core field/i)).toBeTruthy();
  });

  it("enables Required and Visible toggles for a non-locked field", async () => {
    await openEditor("City");

    const required = screen.getByLabelText("Required") as HTMLInputElement;
    const visible = screen.getByLabelText("Visible on form") as HTMLInputElement;
    expect(required.disabled).toBe(false);
    expect(visible.disabled).toBe(false);
  });

  it("marks the locked field with a Core badge and no Hide control", async () => {
    render(<ApplicationBuilderPage />);
    // Wait for the fields to load.
    const firstNameRow = (await screen.findByText("First name")).closest("li")!;
    expect(within(firstNameRow).getByText(/core/i)).toBeTruthy();
    // The hide/show toggle for a locked field is disabled.
    const hideBtn = within(firstNameRow).getByRole("button", { name: /core fields are always visible|Hide "First name"|Show "First name"/i });
    expect((hideBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
