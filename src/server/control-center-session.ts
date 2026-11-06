import { listLocalUsers, type AuthSession } from "../auth.js";

/**
 * A session for a person who has an account on this machine, for work Bob does for them without a page open here: a press that
 * came from their other machine, or a message from their Telegram. Null when the account is not on this machine or is off.
 */
export function bobSessionFor(accountId: string, via: string): AuthSession | null {
  const user = listLocalUsers().find((candidate) => candidate.accountId === accountId && !candidate.disabled);
  return user ? { id: `bob-${via}:${accountId}`, userId: user.userId, username: user.username, accountId, email: user.email, role: user.role, csrfToken: "", mustChangePassword: false, isRemoteLogin: false, homeNodeId: null } : null;
}
