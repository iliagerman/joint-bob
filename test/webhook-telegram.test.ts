import assert from "node:assert/strict";
import test from "node:test";
import { sendTelegramReply, telegramChatId, telegramHtml, telegramParts, telegramText } from "../src/webhook-telegram.js";

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
