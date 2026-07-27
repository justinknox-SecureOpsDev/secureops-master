import { eq } from "drizzle-orm";
import { db, applicationsTable } from "@workspace/db";

// A Drizzle transaction handle, derived from db.transaction's callback param so
// callers can share this reset inside their own atomic delete transaction.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Un-strand every application that points at a user who is about to be (or has
 * just been) deleted. `applications.created_employee_id` has NO foreign key, so
 * deleting the user would otherwise leave the application frozen as "approved"
 * pointing at a now-missing account — making an approved applicant silently
 * vanish from the Onboarding list with no way to log in or finish onboarding.
 *
 * Sends the row back to `under_review` and clears the employee link, both
 * two-admin sign-offs, and the onboarding-email delivery state, so HR can
 * re-approve or reject it later. Shared by the dedicated "Remove from
 * onboarding" action AND the generic admin Users-table delete so the two paths
 * can never drift apart.
 *
 * Runs inside the caller's transaction. Returns the ids of the applications it
 * reset (for audit logging). A no-op (returns []) when nothing references the
 * user.
 */
export async function resetApplicationsForDeletedUser(
  tx: Tx,
  userId: string,
): Promise<string[]> {
  const reset = await tx
    .update(applicationsTable)
    .set({
      status: "under_review",
      createdEmployeeId: null,
      firstApprovedBy: null,
      firstApprovedAt: null,
      secondApprovedBy: null,
      secondApprovedAt: null,
      onboardingEmailStatus: null,
      onboardingEmailMessageId: null,
      onboardingEmailResponse: null,
      onboardingEmailError: null,
      onboardingEmailSentAt: null,
      onboardingEmailAttemptedAt: null,
    })
    .where(eq(applicationsTable.createdEmployeeId, userId))
    .returning({ id: applicationsTable.id });
  return reset.map((r) => r.id);
}
