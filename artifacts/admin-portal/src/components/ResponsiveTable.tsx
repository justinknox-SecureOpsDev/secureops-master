import { Fragment, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";

// ============================================================================
// ResponsiveTable
//
// Encapsulates the "stacked-card-on-mobile / table-on-desktop" pattern that
// was hand-rolled across the Site Detail page (and is spreading to other admin
// pages). A single `columns` array drives BOTH layouts:
//
//   - Desktop (>= md): a bordered, horizontally-scrollable <table> with a
//     muted header row and one <td> per column.
//   - Mobile (< md, via useIsMobile): a vertical list of cards. Each column's
//     `mobile` role decides where it lands inside the card:
//       * "title"   -> bold left side of the card header
//       * "meta"    -> right side of the card header (status / timestamp / etc.)
//       * "field"   -> a label / value row in the 2-col key-value grid (default)
//       * "actions" -> a divided action row at the bottom of the card
//       * "hidden"  -> omitted from the card entirely
//
// Columns may diverge between layouts (e.g. an inline editor on desktop vs a
// read-only value on mobile, or ghost icon buttons vs full-width buttons) by
// supplying `mobileCell` / `mobileLabel` overrides. The component owns only the
// repeated structural markup (the isMobile switch, table/card wrappers, header
// row, key-value grid, action row) so the per-table content stays in the caller
// and renders identically to the previous hand-rolled markup.
// ============================================================================

export type ColumnMobileRole = "title" | "meta" | "field" | "actions" | "hidden";

export interface ResponsiveColumn<T> {
  /** Stable key for this column (used for React keys). */
  id: string;
  /** Desktop column header (also the default mobile field label). */
  header?: ReactNode;
  /** Desktop cell alignment. Defaults to "left". */
  align?: "left" | "right";
  /** Desktop cell content. */
  cell: (row: T) => ReactNode;
  /** Extra className for the desktop <th>. */
  thClassName?: string;
  /** Extra className for the desktop <td>. */
  tdClassName?: string;
  /** Placement of this column inside the mobile card. Defaults to "field". */
  mobile?: ColumnMobileRole;
  /** Mobile key-value-grid label (defaults to `header`). */
  mobileLabel?: ReactNode;
  /** Mobile content (defaults to `cell`). Return null/false to omit. */
  mobileCell?: (row: T) => ReactNode;
  /** Extra className for the mobile field value span. */
  mobileValueClassName?: string;
}

export interface ResponsiveTableProps<T> {
  data: T[];
  columns: ResponsiveColumn<T>[];
  getRowKey: (row: T) => string;
  /** Extra className for each desktop <tr> (string or per-row function). */
  rowClassName?: string | ((row: T) => string);
  /** Extra className for each mobile card (string or per-row function). */
  cardClassName?: string | ((row: T) => string);
  /** Extra className for the mobile card action row (e.g. "items-end"). */
  cardActionsClassName?: string;
  /** Content rendered above the desktop table only (e.g. summary tiles). */
  desktopHeader?: ReactNode;
  /** Extra className for the outer wrapper (the card list / table border box). */
  className?: string;
  /** Extra className for the desktop <thead> (e.g. "text-xs uppercase tracking-wide"). */
  theadClassName?: string;
  /**
   * When set, the desktop table is wrapped in a keyboard-focusable scroll
   * region (`tabIndex=0`, `role="region"`, `aria-label`) inside a `bg-card`
   * bordered box — matching the hand-rolled admin tables and keeping the
   * horizontal-scroll area reachable by keyboard (axe scrollable-region rule).
   * Omit it to keep the plain bordered/scroll wrapper used elsewhere.
   */
  scrollAriaLabel?: string;
  /**
   * Optional per-row ref callback. Return the ref to attach to the row's
   * root element (desktop `<tr>` or mobile card `<div>`) for the given data
   * item, or `undefined` / `null` to skip. Used by the deep-link focus system
   * to scroll-to + flash a specific row without touching every other row.
   */
  getRowRef?: (row: T) => Ref<HTMLElement> | null | undefined;
}

function isRenderable(node: ReactNode): boolean {
  return node != null && node !== false;
}

export function ResponsiveTable<T>({
  data,
  columns,
  getRowKey,
  rowClassName,
  cardClassName,
  cardActionsClassName,
  desktopHeader,
  className,
  theadClassName,
  scrollAriaLabel,
  getRowRef,
}: ResponsiveTableProps<T>) {
  const isMobile = useIsMobile();

  if (isMobile) {
    const titleCols = columns.filter((c) => c.mobile === "title");
    const metaCols = columns.filter((c) => c.mobile === "meta");
    const fieldCols = columns.filter((c) => (c.mobile ?? "field") === "field");
    const actionCols = columns.filter((c) => c.mobile === "actions");

    return (
      <div className={cn("space-y-3", className)}>
        {data.map((row) => {
          const hasActions = actionCols.some((c) => isRenderable((c.mobileCell ?? c.cell)(row)));
          return (
            <div
              key={getRowKey(row)}
              ref={getRowRef?.(row) as Ref<HTMLDivElement> | undefined}
              className={cn(
                "border rounded-lg p-3 space-y-2",
                typeof cardClassName === "function" ? cardClassName(row) : cardClassName,
              )}
            >
              {(titleCols.length > 0 || metaCols.length > 0) && (
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">
                    {titleCols.map((c) => (
                      <Fragment key={c.id}>{(c.mobileCell ?? c.cell)(row)}</Fragment>
                    ))}
                  </span>
                  {metaCols.length > 0 && (
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      {metaCols.map((c) => (
                        <Fragment key={c.id}>{(c.mobileCell ?? c.cell)(row)}</Fragment>
                      ))}
                    </span>
                  )}
                </div>
              )}
              {fieldCols.length > 0 && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  {fieldCols.map((c) => (
                    <Fragment key={c.id}>
                      <span className="text-muted-foreground">{c.mobileLabel ?? c.header}</span>
                      <span className={cn("text-right", c.mobileValueClassName)}>
                        {(c.mobileCell ?? c.cell)(row)}
                      </span>
                    </Fragment>
                  ))}
                </div>
              )}
              {hasActions && (
                <div className={cn("flex flex-wrap items-center gap-2 pt-1 border-t mt-1", cardActionsClassName)}>
                  {actionCols.map((c) => (
                    <Fragment key={c.id}>{(c.mobileCell ?? c.cell)(row)}</Fragment>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const table = (
    <table className="w-full text-sm">
      <thead className={cn("bg-muted/50", theadClassName)}>
        <tr>
          {columns.map((c) => (
            <th
              key={c.id}
              className={cn(
                "px-3 py-2 font-medium",
                c.align === "right" ? "text-right" : "text-left",
                c.thClassName,
              )}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row) => (
          <tr
            key={getRowKey(row)}
            ref={getRowRef?.(row) as Ref<HTMLTableRowElement> | undefined}
            className={cn(
              "border-t",
              typeof rowClassName === "function" ? rowClassName(row) : rowClassName,
            )}
          >
            {columns.map((c) => (
              <td
                key={c.id}
                className={cn("px-3 py-2", c.align === "right" && "text-right", c.tdClassName)}
              >
                {c.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      {desktopHeader}
      {scrollAriaLabel ? (
        <div className={cn("bg-card rounded-lg border overflow-hidden", className)}>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={scrollAriaLabel}>
            {table}
          </div>
        </div>
      ) : (
        <div className={cn("border rounded overflow-x-auto", className)}>{table}</div>
      )}
    </>
  );
}
