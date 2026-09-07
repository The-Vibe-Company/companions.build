/** Deployment allowlist; re-read on each decision so revocation is immediate. */
export function privateBetaEmails(): Set<string> | null {
  const raw = process.env.PRIVATE_BETA_EMAILS;
  if (raw === undefined) return null;
  return new Set(raw.split(/[,\r\n]/).map(email => email.trim().toLowerCase()).filter(email => !!email && !email.includes("*")));
}
export function betaEmailAllowed(email: string): boolean {
  const allowed = privateBetaEmails();
  return allowed === null || allowed.has(email.trim().toLowerCase());
}
export async function privateBetaAccess(ownerId: string, sql: any): Promise<boolean | null> {
  if (privateBetaEmails() === null) return null;
  const [user] = await sql`SELECT email,"emailVerified" FROM "user" WHERE id=${ownerId}`;
  return !!user && user.emailVerified === true && betaEmailAllowed(user.email);
}
export const PRIVATE_BETA_MESSAGE = "Private beta is available by invitation only.";
