// Re-export the employee time-clock screen so admins who also work shifts can
// clock in/out from the admin shell. Time entries key off users.id, so the
// screen works for admin accounts even without an employees row.
export { default } from "../(employee)/clock";
