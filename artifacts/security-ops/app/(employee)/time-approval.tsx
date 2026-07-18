// Re-export the admin time-approval screen so Site Managers can approve time
// entries from inside the employee shell. The screen uses group-agnostic API
// hooks; the server scopes approvable entries to the manager's assigned sites.
export { default } from "../(admin)/time-approval";
