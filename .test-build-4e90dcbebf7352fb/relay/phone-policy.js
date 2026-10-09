import { EventEmitter } from "node:events";
import { otherUsersPhoneSignIn, setOtherUsersPhoneSignIn } from "./store.js";
let database;
const changes = new EventEmitter();
function setPhonePolicyDatabase(db) {
  database = db;
}
function otherUsersMayUsePhone() {
  return database ? otherUsersPhoneSignIn(database) : true;
}
function setOtherUsersMayUsePhone(db, allowed) {
  setOtherUsersPhoneSignIn(db, allowed);
  changes.emit("changed", allowed);
}
function onPhonePolicyChanged(listener) {
  changes.on("changed", listener);
}
export {
  onPhonePolicyChanged,
  otherUsersMayUsePhone,
  setOtherUsersMayUsePhone,
  setPhonePolicyDatabase
};
