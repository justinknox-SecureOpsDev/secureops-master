// Pure logic behind the admin Incidents screen's emergency-alert deep-link
// reveal. An alert tap lands on the Incidents screen carrying the target
// incident id (see resolveNotificationTarget's `emergency` case). The incident
// may not live under the currently-active status filter — the admin may have
// switched filters, or the incident may have since moved to under_review /
// resolved — so the screen fetches it by id, switches the filter to its real
// status, then scrolls to + flashes the exact card. Extracted here so the
// branchy reveal logic can be unit-tested without a React Native renderer.

export type DeepLinkIncident = { id: string; status?: string | null } | null | undefined;

// Given the deep-linked incident (fetched by id) and the currently-active
// status filter, return the filter that should become active so the list will
// contain the incident — or null when no switch is needed. Returns null when:
// there is no deep link, the incident hasn't loaded yet or was deleted (so we
// can't know its status), or it already matches the active filter.
export function resolveDeepLinkFilter(
  highlightIncidentId: string | undefined,
  highlightIncident: DeepLinkIncident,
  currentFilter: string,
): string | null {
  if (!highlightIncidentId || !highlightIncident) return null;
  const status = highlightIncident.status;
  if (status && status !== currentFilter) return status;
  return null;
}

// Locate the deep-linked incident within the currently-rendered list so the
// screen can scroll to + highlight it. Returns -1 when there is no deep link,
// the list hasn't loaded, or the incident isn't in the current list (wrong
// filter still active, or a stale/deleted id).
export function findHighlightIndex(
  incidents: ReadonlyArray<{ id: string }> | null | undefined,
  highlightIncidentId: string | undefined,
): number {
  if (!highlightIncidentId || !incidents) return -1;
  return incidents.findIndex((i) => i.id === highlightIncidentId);
}

// Whether a given incident row is the deep-link target (and should flash).
export function isHighlightedIncident(
  rowId: string,
  highlightIncidentId: string | undefined,
): boolean {
  return !!highlightIncidentId && rowId === highlightIncidentId;
}
