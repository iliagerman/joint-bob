import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const UNAVAILABLE = "Joint Bob supervisor is unavailable";
function validateState(dataDirectory) {
  let directory;
  try { directory = lstatSync(dataDirectory); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (directory.isSymbolicLink() || !directory.isDirectory() || directory.uid !== process.getuid()) throw new Error("Invalid supervisor state directory");
  return realpathSync(dataDirectory);
}
function databasePath(dataDirectory) {
  const directory = validateState(dataDirectory);
  if (!directory) return null;
  const file = path.join(directory, "supervisor.db");
  try {
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.uid !== process.getuid()) throw new Error("Invalid supervisor database");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return { directory, file };
}
function rows(database) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('supervisor_control','supervisor_credentials')").all().map(row => row.name));
  if (!tables.has("supervisor_control")) return { control: undefined, credentials: undefined };
  const control = database.prepare("SELECT socket_path AS socketPath,protocol_version AS protocolVersion FROM supervisor_control WHERE singleton=1").get();
  if (!control) return { control: undefined, credentials: undefined };
  if (!tables.has("supervisor_credentials")) return { control, credentials: undefined };
  const credentials = database.prepare("SELECT token FROM supervisor_credentials WHERE singleton=1").get();
  return { control, credentials };
}
export function readSupervisorControl(dataDirectory) {
  const location = databasePath(dataDirectory);
  if (!location) return null;
  const database = new DatabaseSync(location.file, { readOnly: true });
  try {
    const { control, credentials } = rows(database);
    if (!control && !credentials) return null;
    if (!control || !credentials) throw new Error("Invalid supervisor control database");
    const expected = path.join(location.directory, "supervisor.sock");
    if (!path.isAbsolute(control.socketPath) || Buffer.byteLength(control.socketPath) > 100) throw new Error("Invalid supervisor socket path");
    const socket = lstatSync(control.socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid() || realpathSync(control.socketPath) !== expected) throw new Error("Invalid supervisor socket path");
    return { socketPath: control.socketPath, token: credentials.token, protocolVersion: control.protocolVersion };
  } finally { database.close(); }
}
export function mintTaskToken(dataDirectory, identity) {
  if (typeof identity !== "string" || !identity || identity.length > 1024 || identity.includes("\0")) throw new Error("Invalid task identity");
  const control = readSupervisorControl(dataDirectory);
  if (!control) throw new Error(UNAVAILABLE);
  const location = databasePath(dataDirectory);
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const database = new DatabaseSync(location.file);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare("DELETE FROM supervisor_task_tokens WHERE expires_at<=?").run(Date.now());
    database.prepare("INSERT INTO supervisor_task_tokens VALUES(?,?,?)").run(hash, identity, Date.now() + 30 * 86400_000);
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
  finally { database.close(); }
  return token;
}
export function requestSupervisor(socketPath, token, body, timeoutMs = 15000) {
  if (typeof socketPath !== "string" || !path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) return Promise.reject(new Error("Invalid supervisor socket path"));
  return new Promise((resolve, reject) => {
    const action = body && typeof body.action === "string" ? body.action : "unknown";
    const startedAt = Date.now();
    let reusedSocket = false;
    const request = http.request({ socketPath, path: "/control", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, response => {
      const chunks = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 1024 * 1024) request.destroy(new Error("Supervisor response exceeds 1 MiB")); else chunks.push(chunk); });
      response.on("end", () => {
        if (Date.now() - startedAt > 3000) console.error(`[supervisor-client] ${action} responded ${response.statusCode} after ${Date.now() - startedAt}ms on a ${reusedSocket ? "reused" : "fresh"} socket`);
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { reject(new Error("Malformed supervisor response")); return; }
        if (!value || typeof value !== "object" || (!("result" in value) && typeof value.error !== "string")) { reject(new Error("Malformed supervisor response")); return; }
        if ((response.statusCode ?? 500) < 200 || response.statusCode >= 300) { const error = new Error(value.error); error.status = response.statusCode; reject(error); return; }
        resolve(value.result);
      });
    });
    request.on("socket", () => { reusedSocket = request.reusedSocket === true; });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Supervisor request timed out")));
    request.on("error", error => {
      console.error(`[supervisor-client] ${action} failed after ${Date.now() - startedAt}ms on a ${reusedSocket ? "reused" : "fresh"} socket: ${error.message}`);
      reject(new Error(`Supervisor request failed: ${error.message}`));
    });
    request.end(JSON.stringify(body));
  });
}
export async function supervisorRequest(dataDirectory, body, options = {}) {
  const control = readSupervisorControl(dataDirectory);
  if (!control) throw new Error(UNAVAILABLE);
  return requestSupervisor(control.socketPath, options.token ?? control.token, body, options.timeoutMs ?? 15000);
}
