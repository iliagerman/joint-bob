// This machine's phone-sign-in rule for other users (RELAY-PLAN.md §6 M2), readable by the auth
// gate without importing the relay runtime.
import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { otherUsersPhoneSignIn, setOtherUsersPhoneSignIn } from "./store.js";

let database: DatabaseSync | undefined;
const changes = new EventEmitter();

export function setPhonePolicyDatabase(db: DatabaseSync | undefined): void { database = db; }

/** Whether users whose home is another machine may sign in here from a phone through a relay. */
export function otherUsersMayUsePhone(): boolean { return database ? otherUsersPhoneSignIn(database) : true; }

/** Saves the rule and tells open connections, so turning it off ends other users' phone sockets at once. */
export function setOtherUsersMayUsePhone(db: DatabaseSync, allowed: boolean): void {
  setOtherUsersPhoneSignIn(db, allowed);
  changes.emit("changed", allowed);
}

export function onPhonePolicyChanged(listener: (allowed: boolean) => void): void { changes.on("changed", listener); }
