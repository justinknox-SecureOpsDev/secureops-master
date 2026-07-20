// Re-export the employee profile screen so admins get the same "My Profile"
// surface (contact/HR info, licenses, documents, PDF download, account
// settings) inside the admin shell. The screen reads the signed-in user's own
// record, so it works identically regardless of hosting group.
export { default } from "../(employee)/profile";
