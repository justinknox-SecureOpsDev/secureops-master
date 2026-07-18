// Re-export the admin Time Approval screen so site managers can approve clocked
// hours from inside the employee shell's Schedule section. The screen scopes its
// data server-side to the manager's assigned sites and hides the pay-rate badge
// for site managers (finance invariant). See app/(admin)/time-approval.tsx.
export { default } from "../../(admin)/time-approval";
