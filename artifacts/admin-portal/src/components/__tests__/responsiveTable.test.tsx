import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

/**
 * Unit coverage for the shared `ResponsiveTable` component, which drives BOTH
 * the desktop <table> and the mobile stacked-card layout from a single
 * `columns` array. A future change to its column-role logic (title / meta /
 * field / actions placement, the isMobile switch, or the action-row visibility
 * rule) would silently break layouts on phones or desktop with nothing else
 * failing — these tests lock that behaviour in.
 *
 * `useIsMobile` is the single switch between the two layouts, so it is mocked
 * directly: each suite sets the desired viewport before rendering. Everything
 * else (column slotting, override resolution, action-row visibility) is pure
 * markup driven by the `columns`/`data` props, so no other stubbing is needed.
 */

const hoisted = vi.hoisted(() => ({ isMobile: false }));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => hoisted.isMobile,
}));

// Imported after the mock so the mocked hook is picked up.
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ResponsiveTable";

type Row = { id: string; name: string; status: string; rate: number };

const rows: Row[] = [
  { id: "r1", name: "Alice", status: "active", rate: 25 },
  { id: "r2", name: "Bob", status: "inactive", rate: 30 },
];

function baseColumns(): ResponsiveColumn<Row>[] {
  return [
    { id: "name", header: "Name", mobile: "title", cell: (r) => r.name },
    { id: "status", header: "Status", mobile: "meta", cell: (r) => r.status },
    { id: "rate", header: "Rate", cell: (r) => `$${r.rate}` }, // defaults to "field"
  ];
}

describe("ResponsiveTable desktop layout", () => {
  beforeEach(() => {
    hoisted.isMobile = false;
  });

  it("renders a table header and one row per item", () => {
    render(
      <ResponsiveTable
        data={rows}
        columns={baseColumns()}
        getRowKey={(r) => r.id}
      />,
    );

    // A real <table> with a header cell per column.
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["Name", "Status", "Rate"]);

    // One body <tr> per data item (header row excluded).
    const bodyRows = within(table.querySelector("tbody")!).getAllByRole("row");
    expect(bodyRows).toHaveLength(rows.length);

    // Each desktop row renders the desktop `cell` content.
    expect(within(bodyRows[0]).getByText("Alice")).toBeTruthy();
    expect(within(bodyRows[0]).getByText("$25")).toBeTruthy();
    expect(within(bodyRows[1]).getByText("Bob")).toBeTruthy();
  });

  it("uses the desktop `cell`/`header`, ignoring mobile overrides", () => {
    const columns: ResponsiveColumn<Row>[] = [
      {
        id: "name",
        header: "Name",
        mobile: "title",
        cell: (r) => `desktop:${r.name}`,
        mobileCell: (r) => `mobile:${r.name}`,
        mobileLabel: "Mobile Name",
      },
    ];
    render(
      <ResponsiveTable data={rows} columns={columns} getRowKey={(r) => r.id} />,
    );

    expect(screen.getByText("desktop:Alice")).toBeTruthy();
    expect(screen.queryByText("mobile:Alice")).toBeNull();
    expect(screen.queryByText("Mobile Name")).toBeNull();
  });

  it("renders the desktopHeader above the table", () => {
    render(
      <ResponsiveTable
        data={rows}
        columns={baseColumns()}
        getRowKey={(r) => r.id}
        desktopHeader={<div>Summary Tiles</div>}
      />,
    );
    expect(screen.getByText("Summary Tiles")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
  });
});

describe("ResponsiveTable mobile layout", () => {
  beforeEach(() => {
    hoisted.isMobile = true;
  });

  it("renders one card per item with no <table>", () => {
    render(
      <ResponsiveTable
        data={rows}
        columns={baseColumns()}
        getRowKey={(r) => r.id}
      />,
    );

    // No desktop table at all on mobile.
    expect(screen.queryByRole("table")).toBeNull();

    // Title and meta values render for each item.
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText("inactive")).toBeTruthy();
  });

  it("places columns in the correct card slot by `mobile` role", () => {
    const { container } = render(
      <ResponsiveTable
        data={[rows[0]]}
        columns={[
          { id: "name", header: "Name", mobile: "title", cell: (r) => r.name },
          {
            id: "status",
            header: "Status",
            mobile: "meta",
            cell: (r) => r.status,
          },
          { id: "rate", header: "Rate", cell: (r) => `$${r.rate}` }, // field (default)
          {
            id: "secret",
            header: "Secret",
            mobile: "hidden",
            cell: () => "should-not-render",
          },
        ]}
        getRowKey={(r) => r.id}
      />,
    );

    const card = container.querySelector(".border.rounded-lg") as HTMLElement;
    expect(card).toBeTruthy();

    // title -> bold left span of the header row.
    const title = within(card).getByText("Alice");
    expect(title.closest("span")?.className).toContain("font-medium");

    // meta -> right side of the header row.
    expect(within(card).getByText("active")).toBeTruthy();

    // field -> key/value grid: the label (header) and the value both render.
    expect(within(card).getByText("Rate")).toBeTruthy();
    expect(within(card).getByText("$25")).toBeTruthy();

    // hidden -> omitted entirely.
    expect(within(card).queryByText("should-not-render")).toBeNull();
  });

  it("shows the action row only when an actions column returns content", () => {
    const columns = (
      actionCell: (r: Row) => React.ReactNode,
    ): ResponsiveColumn<Row>[] => [
      { id: "name", header: "Name", mobile: "title", cell: (r) => r.name },
      { id: "act", header: "", mobile: "actions", cell: actionCell },
    ];

    // Actions returning content -> the divided action row appears.
    const withActions = render(
      <ResponsiveTable
        data={[rows[0]]}
        columns={columns((r) => <button>Edit {r.name}</button>)}
        getRowKey={(r) => r.id}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit Alice" })).toBeTruthy();
    const cardWith = withActions.container.querySelector(
      ".border.rounded-lg",
    ) as HTMLElement;
    // The action row carries a top border divider.
    expect(cardWith.querySelector(".border-t")).toBeTruthy();
    withActions.unmount();

    // Actions returning null -> no action row (no divider) is rendered.
    const noActions = render(
      <ResponsiveTable
        data={[rows[0]]}
        columns={columns(() => null)}
        getRowKey={(r) => r.id}
      />,
    );
    const cardWithout = noActions.container.querySelector(
      ".border.rounded-lg",
    ) as HTMLElement;
    expect(cardWithout.querySelector(".border-t")).toBeNull();
  });

  it("prefers `mobileCell` and `mobileLabel` over the desktop `cell`/`header`", () => {
    const { container } = render(
      <ResponsiveTable
        data={[rows[0]]}
        columns={[
          {
            id: "name",
            header: "Name",
            mobile: "title",
            cell: (r) => `desktop:${r.name}`,
            mobileCell: (r) => `mobile:${r.name}`,
          },
          {
            id: "rate",
            header: "Desktop Rate",
            cell: (r) => `desktop:${r.rate}`,
            mobileLabel: "Mobile Rate",
            mobileCell: (r) => `mobile:$${r.rate}`,
          },
        ]}
        getRowKey={(r) => r.id}
      />,
    );

    const card = container.querySelector(".border.rounded-lg") as HTMLElement;

    // Title uses the mobile override, not the desktop cell.
    expect(within(card).getByText("mobile:Alice")).toBeTruthy();
    expect(within(card).queryByText("desktop:Alice")).toBeNull();

    // Field uses mobileLabel + mobileCell, not header + desktop cell.
    expect(within(card).getByText("Mobile Rate")).toBeTruthy();
    expect(within(card).queryByText("Desktop Rate")).toBeNull();
    expect(within(card).getByText("mobile:$25")).toBeTruthy();
    expect(within(card).queryByText("desktop:25")).toBeNull();
  });
});
