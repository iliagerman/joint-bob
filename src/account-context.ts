import { AsyncLocalStorage } from "node:async_hooks";
import type { AccountRole } from "./accounts.js";

/**
 * The person a piece of work is done for. Request handlers run inside the signed-in
 * account; background work for a project runs inside its owner. Code with no acting
 * account is the node itself (startup, replication, maintenance) and sees everything.
 */
export interface ActingAccount {
  accountId: string;
  /** This node's user id; absent for an account acting through a peer. */
  userId?: string;
  username: string;
  email?: string | null;
  role: AccountRole | null;
  /** Signed in here, but at home on another node. */
  isRemoteLogin: boolean;
  homeNodeId: string | null;
}

const storage = new AsyncLocalStorage<ActingAccount>();

export function runAsAccount<T>(account: ActingAccount | undefined, work: () => T): T {
  return account ? storage.run(account, work) : storage.exit(work);
}

export function actingAccount(): ActingAccount | undefined {
  return storage.getStore();
}

/** Runs `work` as the node itself, outside whatever account the caller acts for. */
export function asNode<T>(work: () => T): T {
  return storage.exit(work);
}

export function actingAccountFromSession(session: { userId: string; username: string; accountId: string; email: string | null; role: AccountRole | null; isRemoteLogin: boolean; homeNodeId: string | null }): ActingAccount {
  return { accountId: session.accountId, userId: session.userId, username: session.username, email: session.email, role: session.role, isRemoteLogin: session.isRemoteLogin, homeNodeId: session.homeNodeId };
}
