import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { transcribeWithElevenLabs } from "../src/server/speech-to-text.js";
import { sendTelegramFile, sendTelegramReply, sendTelegramVoice, telegramChatId, telegramDownload, telegramHtml, telegramParts, telegramSpoken, telegramText } from "../src/webhook-telegram.js";

test("a Telegram update names its chat and what the person wrote", () => {
  assert.equal(telegramChatId({ message: { chat: { id: 111 }, text: "hi" } }), "111");
  assert.equal(telegramChatId({ edited_message: { chat: { id: -5 } } }), "-5");
  assert.equal(telegramChatId({ callback_query: { data: "yes", message: { chat: { id: 7 } } } }), "7");
  assert.equal(telegramChatId({ anything: true }), null);
  assert.equal(telegramChatId(undefined), null);
  assert.equal(telegramText({ message: { text: "hi" } }), "hi");
  assert.equal(telegramText({ message: { caption: "a photo" } }), "a photo");
  assert.equal(telegramText({ callback_query: { data: "yes", message: { text: "Sure?" } } }), "yes", "the tap, not the question");
  assert.equal(telegramText({ message: { sticker: {} } }), null);
});

test("Markdown becomes the formatting Telegram can show, and nothing else is parsed", () => {
  assert.equal(telegramHtml("## Report **today**\n\n- **Urgent:** call <Noa> & Dan\n- see [the plan](https://example.com/a?b=1)"),
    '<b>Report today</b>\n\n• <b>Urgent:</b> call &lt;Noa&gt; &amp; Dan\n• see <a href="https://example.com/a?b=1">the plan</a>');
  assert.equal(telegramHtml("`a<b` and ```js\nif (a < b) {}\n```"), "<code>a&lt;b</code> and <pre>if (a &lt; b) {}</pre>");
  assert.equal(telegramHtml("[x](javascript:alert(1))"), "[x](javascript:alert(1))", "only web links become links");
  assert.equal(telegramHtml("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(telegramHtml("| a | b |\n| - | - |\n| 1 | 2 |"), "<pre>| a | b |\n| - | - |\n| 1 | 2 |</pre>\n");
  assert.equal(telegramHtml("*one* 2*3*4"), "<i>one</i> 2*3*4", "a star inside a word stays a star");
});

test("a long answer splits between paragraphs and stays under Telegram's limit", () => {
  const parts = telegramParts(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}\n\n${"c".repeat(100)}`);
  assert.deepEqual(parts.map(part => part.length), [3000, 3102]);
  assert.ok(telegramParts("x".repeat(9000)).every(part => part.length <= 3500), "text with no breaks is still cut");
  assert.deepEqual(telegramParts("  short  "), ["short"]);
  assert.deepEqual(telegramParts("   "), []);
});

test("formatting Telegram rejects falls back to plain text, and a refused reply is an error", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const answer = (status: number, description: string) => new Response(JSON.stringify({ description }), { status });
  await sendTelegramReply("tok", "111", "**hi**", { fetchImpl: (async (url: string, init: RequestInit) => {
    assert.match(url, /\/bottok\/sendMessage$/);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push(body);
    return body.parse_mode ? answer(400, "can't parse entities") : answer(200, "");
  }) as typeof fetch });
  assert.deepEqual(sent, [{ chat_id: "111", text: "<b>hi</b>", parse_mode: "HTML" }, { chat_id: "111", text: "**hi**" }]);
  await assert.rejects(sendTelegramReply("tok", "111", "hi", { fetchImpl: (async () => answer(403, "bot was blocked by the user")) as typeof fetch }), /bot was blocked by the user/);
});

test("a file is sent the way Telegram shows its type, and what that way refuses goes as a document", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "telegram-send-"));
  try {
    const sent: Array<{ method: string; field: string; name: string; chat: unknown }> = [];
    let refuse = "";
    const fake = (async (url: string, init: RequestInit) => {
      const method = url.split("/").at(-1)!;
      const form = init.body as FormData;
      const [field, file] = [...form.entries()].find(([, value]) => value instanceof File) as [string, File];
      sent.push({ method, field, name: file.name, chat: form.get("chat_id") });
      return new Response(JSON.stringify({ description: "Bad Request" }), { status: method === refuse ? 400 : 200 });
    }) as typeof fetch;
    const expected: Array<[string, string, string]> = [["a.PNG", "sendPhoto", "photo"], ["b.gif", "sendAnimation", "animation"], ["c.mp4", "sendVideo", "video"], ["d.mp3", "sendAudio", "audio"], ["e.ogg", "sendVoice", "voice"], ["f.pdf", "sendDocument", "document"], ["no-extension", "sendDocument", "document"]];
    for (const [name] of expected) await writeFile(path.join(folder, name), "x");
    for (const [name, method, field] of expected) {
      await sendTelegramFile("tok", "111", path.join(folder, name), fake);
      assert.deepEqual(sent.at(-1), { method, field, name, chat: "111" });
    }
    sent.length = 0;
    refuse = "sendPhoto";
    await sendTelegramFile("tok", "111", path.join(folder, "a.PNG"), fake);
    assert.deepEqual(sent.map(item => item.method), ["sendPhoto", "sendDocument"]);
    refuse = "sendDocument";
    await assert.rejects(sendTelegramFile("tok", "111", path.join(folder, "f.pdf"), fake), /Bad Request/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("a file downloads through the path Telegram names, and a refusal is an error", async () => {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    if (url.endsWith("/getFile")) return new Response(JSON.stringify({ result: { file_path: "voice/file_1.oga" } }));
    return new Response("bytes");
  }) as typeof fetch;
  assert.equal((await telegramDownload("tok", "id", fake)).toString(), "bytes");
  assert.match(urls[1], /\/file\/bottok\/voice\/file_1\.oga$/);
  await assert.rejects(telegramDownload("tok", "id", (async () => new Response(JSON.stringify({ description: "Bad Request: file is too big" }), { status: 400 })) as typeof fetch), /file is too big/);
});

test("speech becomes words through ElevenLabs, and a refusal says why", async () => {
  const words = await transcribeWithElevenLabs("key", Buffer.from("sound"), "voice.ogg", "audio/ogg", (async (url: string, init: RequestInit) => {
    assert.match(url, /\/v1\/speech-to-text$/);
    assert.deepEqual(init.headers, { "xi-api-key": "key" });
    const form = init.body as FormData;
    assert.equal(form.get("model_id"), "scribe_v2");
    const file = form.get("file") as File;
    assert.equal(file.name, "voice.ogg");
    assert.equal(await file.text(), "sound");
    return new Response(JSON.stringify({ text: "  hello there " }));
  }) as typeof fetch);
  assert.equal(words, "hello there");
  await assert.rejects(transcribeWithElevenLabs("key", Buffer.from("x"), "v.ogg", "audio/ogg", (async () => new Response(JSON.stringify({ detail: { message: "quota exceeded" } }), { status: 401 })) as typeof fetch), /quota exceeded/);
});

test("an answer is read aloud without its formatting, and says when something was left out", () => {
  assert.deepEqual(telegramSpoken("## Plan\n\n- **Book** the *hotel* by `Friday`.\n\n---\n\nThat's ~~all~~ it."), { speech: "Plan\nBook the hotel by Friday.\nThat's all it.", complete: true });
  assert.deepEqual(telegramSpoken("See [the plan](https://example.com/a) now."), { speech: "See the plan now.", complete: false });
  assert.deepEqual(telegramSpoken("Go to https://example.com/a now."), { speech: "Go to  now.", complete: false });
  assert.deepEqual(telegramSpoken("Run this:\n```sh\nls\n```"), { speech: "Run this:", complete: false });
  assert.deepEqual(telegramSpoken("| a | b |\n| 1 | 2 |\n"), { speech: "", complete: false });
});

test("a voice reply goes as a voice message, answering the message it was asked in", async () => {
  const sent: Array<{ url: string; form: FormData }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    sent.push({ url, form: init.body as FormData });
    return new Response("{}");
  }) as typeof fetch;
  await sendTelegramVoice("tok", "-5", Buffer.from("mp3"), { replyTo: 9, fetchImpl: fake });
  assert.match(sent[0].url, /\/bottok\/sendVoice$/);
  assert.equal(sent[0].form.get("chat_id"), "-5");
  assert.deepEqual(JSON.parse(String(sent[0].form.get("reply_parameters"))), { message_id: 9, allow_sending_without_reply: true });
  const voice = sent[0].form.get("voice") as File;
  assert.deepEqual([voice.name, voice.type, await voice.text()], ["voice.mp3", "audio/mpeg", "mp3"]);
  await assert.rejects(sendTelegramVoice("tok", "-5", Buffer.from("mp3"), { fetchImpl: (async () => new Response(JSON.stringify({ description: "VOICE_MESSAGES_FORBIDDEN" }), { status: 400 })) as typeof fetch }), /VOICE_MESSAGES_FORBIDDEN/);
});
