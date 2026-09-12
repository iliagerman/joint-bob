import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { BrowserRuntime } from "../../src/browser-runtime.js";

// Native regression source only. Run exclusively in the designated browser test
// environment, never against a user's profile or WhatsApp account.
test("native profiles retain nonextractable IndexedDB keys and isolate two accounts across restart", { timeout: 120000 }, async () => {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === "/sw.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(`self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', event => {
          if (new URL(event.request.url).pathname === '/worker-proof')
            event.respondWith(caches.open('native-login').then(cache => cache.match('/account-proof')));
        });`);
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end("<title>Native persistence fixture</title>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const start = { projectId: randomUUID(), engine: "pi" as const, conversationId: randomUUID(), appNodeId: randomUUID(), url: `${origin}/callback?operation=once` };
  const agent = { kind: "agent" } as const;
  let runtime = new BrowserRuntime();
  const evaluate = (id: string, expression: string) => runtime.execute(id, { action: "evaluate", expression }, agent);
  try {
    const personal = await runtime.create({ ...start, profileName: "Personal" });
    const work = await runtime.create({ ...start, profileName: "Work" });
    const signatures: unknown[] = [];
    for (const [index, session] of [personal, work].entries()) {
      signatures.push(await evaluate(session.id, `(async () => {
        const key = await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'}, false, ['sign']);
        const db = await new Promise((resolve,reject) => {
          const request=indexedDB.open('native-login',1);
          request.onupgradeneeded=()=>request.result.createObjectStore('auth');
          request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
        });
        await new Promise((resolve,reject) => {
          const tx=db.transaction('auth','readwrite');
          tx.objectStore('auth').put(key,'key');
          tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
        });
        db.close(); localStorage.setItem('account','account-${index}');
        document.cookie='account=account-${index}; Max-Age=3600; Path=/; SameSite=Lax';
        const cache = await caches.open('native-login');
        await cache.put('/account-proof', new Response('worker-account-${index}'));
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise(resolve =>
          navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true}));
        return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('proof'))));
      })()`));
    }
    assert.notDeepEqual(signatures[0], signatures[1], "Accounts must use separate signing keys");
    await runtime.execute(personal.id, { action: "takeControl" }, { kind: "human", id: "fixture-human" });
    await runtime.close();
    requests.length = 0;
    runtime = new BrowserRuntime();
    await runtime.ready();
    assert.equal((await runtime.get(personal.id)).owner, "human");
    await assert.rejects(evaluate(personal.id, "localStorage.setItem('account','agent-overwrite')"), /human control/i, "Restored human pause must reject agent writes");
    await assert.rejects(runtime.execute(personal.id, { action: "resumeAgent" }, agent), /human/i);
    await assert.rejects(runtime.execute(personal.id, { action: "resumeAgent" }, { kind: "human", id: "wrong-human" }), /another|owned/i);
    await runtime.execute(personal.id, { action: "resumeAgent" }, { kind: "human", id: "fixture-human" });
    for (const [index, session] of [personal, work].entries()) {
      const restored = await runtime.get(session.id);
      assert.equal(restored.profileId, session.profileId);
      assert.notEqual(restored.activePageId, session.activePageId);
      const durable: any = await evaluate(session.id, `(async () => ({
        cookie: document.cookie,
        worker: (await navigator.serviceWorker.getRegistration())?.active?.scriptURL,
        response: await (await fetch('/worker-proof')).text()
      }))()`);
      assert.equal(durable.cookie, `account=account-${index}`, "Persistent cookies must survive restart in their own account");
      assert.equal(durable.worker, `${origin}/sw.js`, "Service worker registration must survive restart without re-registering");
      assert.equal(durable.response, `worker-account-${index}`, "Restored worker must serve its account's persisted CacheStorage");
      const proof: any = await evaluate(session.id, `(async () => {
        const db=await new Promise((resolve,reject)=>{ const request=indexedDB.open('native-login',1); request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
        const key=await new Promise((resolve,reject)=>{ const request=db.transaction('auth').objectStore('auth').get('key'); request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
        db.close();
        return {account:localStorage.getItem('account'),extractable:key.extractable,signature:Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('proof'))))};
      })()`);
      assert.equal(proof.account, `account-${index}`);
      assert.equal(proof.extractable, false);
      assert.deepEqual(proof.signature, signatures[index]);
      await runtime.execute(session.id, { action: "close" }, agent);
    }
    assert.equal(requests.some(url => url.includes("callback") || url.includes("operation=")), false, "Restart must never replay callback/action URLs");
  } finally {
    await runtime.close();
    server.close();
    await once(server, "close");
  }
});
