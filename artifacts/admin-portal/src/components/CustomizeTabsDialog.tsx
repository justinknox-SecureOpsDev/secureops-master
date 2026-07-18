import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import { useUpdateMyUiPreferences } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { LucideIcon } from "lucide-react";

type GroupOption = { key: string; label: string; Icon: LucideIcon };

/**
 * Lets the signed-in user rearrange the top-level nav tabs to their own
 * preferred order. The order is saved on the account (server-side), so it
 * follows the user across browsers and devices. Cosmetic only — it never
 * changes which tabs a role can see.
 */
export function CustomizeTabsDialog({
  open,
  onOpenChange,
  groups,
  defaultKeys,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Groups in the user's CURRENT effective order (starting point). */
  groups: GroupOption[];
  /** Role-default order, used by "Reset to default". */
  defaultKeys: string[];
  onSaved: (order: string[]) => void;
}) {
  const currentKeys = useMemo(() => groups.map((g) => g.key), [groups]);
  const [order, setOrder] = useState<string[]>(currentKeys);
  const [error, setError] = useState<string | null>(null);

  // Re-seed local state each time the dialog opens so it always starts from
  // the live order (including changes saved in a previous open).
  useEffect(() => {
    if (open) {
      setOrder(currentKeys);
      setError(null);
    }
  }, [open, currentKeys]);

  const byKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups]);

  const move = (index: number, delta: -1 | 1) => {
    setOrder((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const { mutate: savePrefs, isPending } = useUpdateMyUiPreferences({
    mutation: {
      onSuccess: (_data, variables) => {
        onSaved(variables.data.navGroupOrder ?? []);
        onOpenChange(false);
      },
      onError: () => {
        setError("Could not save your tab order. Please try again.");
      },
    },
  });

  const save = () => {
    setError(null);
    // If the chosen order matches the role default, store an empty list
    // instead of pinning today's default — that way the user tracks any
    // future changes to the default order until they customize again.
    const isDefault =
      order.length === defaultKeys.length && order.every((k, i) => k === defaultKeys[i]);
    savePrefs({ data: { navGroupOrder: isDefault ? [] : order } });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Customize tabs</DialogTitle>
          <DialogDescription>
            Arrange the top navigation tabs in the order you prefer. This only
            changes your own view and is saved to your account.
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-1" aria-label="Tab order">
          {order.map((key, i) => {
            const g = byKey.get(key);
            if (!g) return null;
            const Icon = g.Icon;
            return (
              <li
                key={key}
                className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2"
              >
                <span className="w-5 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="flex-1 text-sm">{g.label}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${g.label} up`}
                >
                  <ArrowUp className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${g.label} down`}
                >
                  <ArrowDown className="w-4 h-4" />
                </Button>
              </li>
            );
          })}
        </ol>

        {error && (
          <p className="text-sm text-destructive" role="alert">{error}</p>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOrder(defaultKeys)}
            className="gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset to default
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={isPending}>
              {isPending ? "Saving…" : "Save order"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
