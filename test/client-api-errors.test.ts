import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = (await readFile("public/app/api.js", "utf8")).replace(/^import .*;\n/gm, "").replace(/^export /gm, "");

function client(fetch: (...args: any[]) => any) {
  const logs: unknown[][] = [];
  let signedOut = false;
  const requests = runInNewContext(`${source}\n({ api, apiBlob, apiLines })`, {
    fetch, Error, console: { warn: (...args: unknown[]) => logs.push(args) },
    state: { csrfToken: "synthetic-csrf" }, showSignedOut: () => { signedOut = true; }, TextDecoderStream,
  });
  return { ...requests, logs, signedOut: () => signedOut };
}

test("an unexplained fetch abort names the request and is not treated as user cancellation", async () => {
  const error = new DOMException("This operation was aborted", "AbortError");
  const request = client(async () => { throw error; });
  await assert.rejects(request.api("/api/projects?search=private-query#private-fragment"), (failure: any) => {
    assert.match(failure.message, /GET \/api\/projects/);
    assert.match(failure.message, /interrupted/i);
    assert.doesNotMatch(failure.message, /timed out|private-query|private-fragment/);
    assert.equal(failure.cancelled, false);
    assert.equal(failure.name, "AbortError", "existing GET-only timeout retry logic needs the original name");
    assert.equal(failure.status, 0);
    assert.equal(failure.path, "/api/projects");
    assert.equal(failure.cause, error);
    return true;
  });
  assert.equal(request.logs.length, 1, "caught failures must still reach Settings logs");
  assert.match(JSON.stringify(request.logs), /GET.*\/api\/projects/);
  assert.doesNotMatch(JSON.stringify(request.logs), /private-query|private-fragment|synthetic-csrf/);
});

test("a server-side abort identifies the write and warns that its outcome is unknown", async () => {
  let calls = 0;
  const request = client(async () => {
    calls++;
    return Response.json({ error: "This operation was aborted" }, { status: 500 });
  });
  await assert.rejects(request.api("/api/preferences?token=private-token", {
    method: "put", body: JSON.stringify({ password: "private-body" }), headers: { Authorization: "private-header" },
  }), (failure: any) => {
    assert.match(failure.message, /PUT \/api\/preferences/);
    assert.match(failure.message, /interrupted/i);
    assert.match(failure.message, /check.*before.*try/i);
    assert.equal(failure.status, 500);
    assert.equal(failure.cancelled, false);
    return true;
  });
  assert.equal(calls, 1, "never replay an uncertain write");
  assert.doesNotMatch(JSON.stringify(request.logs), /private-token|private-body|private-header|synthetic-csrf/);
});

test("only a confirmed caller cancellation is quiet", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = client(async () => { throw controller.signal.reason; });
  await assert.rejects(request.api("/api/projects", { signal: controller.signal }), (failure: any) => {
    assert.equal(failure.cancelled, true);
    assert.equal(failure.name, "AbortError");
    return true;
  });
  assert.equal(request.logs.length, 0);
});

test("an aborted signal does not hide an unrelated failure", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = client(async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(request.api("/api/projects", { signal: controller.signal }), (failure: any) => {
    assert.equal(failure.cancelled, false);
    assert.match(failure.message, /GET \/api\/projects/);
    return true;
  });
  assert.equal(request.logs.length, 1);
});

test("a caller timeout stays visible and retains its error name", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("The operation timed out", "TimeoutError"));
  const request = client(async () => { throw controller.signal.reason; });
  await assert.rejects(request.api("/api/usage", { signal: controller.signal }), (failure: any) => {
    assert.equal(failure.cancelled, false);
    assert.equal(failure.name, "TimeoutError");
    assert.match(failure.message, /GET \/api\/usage.*timed out/);
    return true;
  });
  assert.equal(request.logs.length, 1);
});

for (const kind of ["api", "apiBlob", "apiLines"]) {
  test(`${kind} preserves request context when the response body is interrupted`, async () => {
    const error = new DOMException("This operation was aborted", "AbortError");
    const request = client(async () => new Response(new ReadableStream({ start(stream) { stream.error(error); } }), {
      headers: { "Content-Type": kind === "apiLines" ? "application/x-ndjson" : "application/json" },
    }));
    await assert.rejects(request[kind]("/api/story", {}, () => {}), (failure: any) => {
      assert.match(failure.message, /GET \/api\/story.*interrupted/);
      assert.equal(failure.status, 200);
      assert.equal(failure.cancelled, false);
      return true;
    });
    assert.equal(request.logs.length, 1);
  });
}

test("HTTP errors retain server explanations and conflict details", async () => {
  const details = { code: "transcript-conflict", sources: ["fixture"] };
  const request = client(async () => Response.json({ error: "History differs between machines", details }, { status: 409 }));
  await assert.rejects(request.api("/api/projects/example/sessions/take-ownership", { method: "POST" }), (failure: any) => {
    assert.match(failure.message, /POST \/api\/projects\/example\/sessions\/take-ownership/);
    assert.match(failure.message, /History differs between machines/);
    assert.equal(failure.status, 409);
    assert.deepEqual(failure.details, details);
    return true;
  });
});

test("a gateway timeout has a useful explanation even with a non-JSON error body", async () => {
  const request = client(async () => new Response("<html>private gateway response</html>", { status: 504 }));
  await assert.rejects(request.api("/api/projects"), /GET \/api\/projects.*timed out/);
  assert.doesNotMatch(JSON.stringify(request.logs), /private gateway response/);
});

test("authentication handling and successful responses remain unchanged", async () => {
  const unauthorized = client(async () => Response.json({ error: "Sign in required" }, { status: 401 }));
  await assert.rejects(unauthorized.api("/api/projects"), /Sign in required/);
  assert.equal(unauthorized.signedOut(), true);
  const signIn = client(async () => Response.json({ error: "Invalid credentials" }, { status: 401 }));
  await assert.rejects(signIn.api("/api/auth/login", { method: "POST" }));
  assert.equal(signIn.signedOut(), false);
  const json = client(async () => Response.json({ ok: true }));
  assert.deepEqual(await json.api("/api/projects"), { ok: true });
  const empty = client(async () => new Response(null, { status: 204 }));
  assert.equal(await empty.api("/api/projects", { method: "DELETE" }), null);
  const binary = client(async () => new Response("audio"));
  assert.equal(await (await binary.apiBlob("/api/story")).text(), "audio");
  const lines = client(async () => new Response('{"type":"progress"}\n{"type":"done"}', { headers: { "Content-Type": "application/x-ndjson" } }));
  const received: unknown[] = [];
  await lines.apiLines("/api/story", {}, (line: unknown) => received.push(line));
  assert.equal(JSON.stringify(received), '[{"type":"progress"},{"type":"done"}]');
  assert.deepEqual([...json.logs, ...empty.logs, ...binary.logs, ...lines.logs], []);
});
