// Re-export the admin Shift Approvals screen so site managers can approve/decline
// officer self-claims from inside the employee shell's Schedule section. The
// underlying GET /shifts list is scoped server-side to the manager's assigned
// sites. See app/(admin)/shift-approvals.tsx.
export { default } from "../../(admin)/shift-approvals";
