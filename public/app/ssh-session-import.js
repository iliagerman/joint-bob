// MobaXterm bookmark exports store SSH connection fields as #109#…%host%port%username.
// Import connection metadata only. Later fields can contain client settings or credentials.
export function parseMobaSshSession(contents) {
  let inBookmarks = false;
  const sessions = [];
  for (const line of contents.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) { inBookmarks = section[1] === "Bookmarks"; continue; }
    if (!inBookmarks) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const fields = line.slice(separator + 1).split("%");
    if (!/^#109#\d+$/.test(fields[0].trim())) continue;
    const [host = "", port = "", username = ""] = fields.slice(1, 4);
    sessions.push({ host: host.trim(), port: port.trim(), username: username.trim() });
  }
  if (sessions.length !== 1) throw new Error("Import a .mxtsessions file with exactly one SSH session");
  const session = sessions[0];
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(session.host) || !/^\d+$/.test(session.port) || Number(session.port) < 1 || Number(session.port) > 65535) throw new Error("MobaXterm SSH session has an invalid host or port");
  if (session.username.length > 128 || /[\x00-\x1f\x7f]/.test(session.username)) throw new Error("MobaXterm SSH session has an invalid username");
  return session;
}
