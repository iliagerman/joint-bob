// One request helper for the assistant page, and the live change stream.

let csrf = "";

export function setCsrf(token) { csrf = token; }

export async function request(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options,
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}), ...options.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export const post = (path, body = {}) => request(path, { method: "POST", body: JSON.stringify(body) });
export const put = (path, body) => request(path, { method: "PUT", body: JSON.stringify(body) });
export const del = path => request(path, { method: "DELETE" });

/** Change signals for this person (ids only). The browser reconnects an EventSource by itself. */
export function subscribe(listener) {
  const source = new EventSource("/api/social/events");
  source.addEventListener("message", event => {
    try { listener(JSON.parse(event.data)); } catch (error) { console.error("Assistant page: bad change signal", error); }
  });
  return () => source.close();
}
