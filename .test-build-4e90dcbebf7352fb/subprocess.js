import { execFile as nativeExecFile, spawn as nativeSpawn } from "node:child_process";
import { promisify } from "node:util";
import { watchSubprocess } from "../scripts/subprocess-lifetime.mjs";
import { resolveDataDirectory } from "./data-directory.js";
function trackSubprocess(child) {
  watchSubprocess(child, { dataDirectory: resolveDataDirectory() });
}
const spawn = ((...args) => {
  const child = nativeSpawn(...args);
  trackSubprocess(child);
  return child;
});
const execFile = ((...args) => {
  const child = Reflect.apply(nativeExecFile, void 0, args);
  trackSubprocess(child);
  return child;
});
Object.defineProperty(execFile, promisify.custom, { value: (...args) => {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = Reflect.apply(execFile, void 0, [...args, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    }]);
  });
  return Object.assign(promise, { child });
} });
export {
  execFile,
  spawn,
  trackSubprocess
};
