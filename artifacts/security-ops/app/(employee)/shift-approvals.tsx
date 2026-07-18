// Re-export the admin shift-approvals screen so Site Managers can approve
// pending shift claims from inside the employee shell. The screen uses
// group-agnostic API hooks; the server scopes approvable claims to the
// manager's assigned sites.
export { default } from "../(admin)/shift-approvals";
