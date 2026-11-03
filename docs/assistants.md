# Assistants

An assistant is a conversation you turned into a long-lived helper. You chat with it as one continuous conversation; behind the scenes it keeps separate topics and resumes the right one. This page covers what it can use, how other people find it, groups, and the public actions other people may request.

To switch from the workspace to your assistants, choose **Assistants** (the robot face) in the toolbar above the project list. On a phone, use the app icon's **Assistants** shortcut. **Workspace** at the top of the assistants page takes you back.

## Resources

The **Resources** tab lists what the assistant may use. Every topic it opens gets the same set.

- **Browser logins.** A saved browser profile the assistant stays signed in with, such as WhatsApp or LinkedIn. **Add login** opens a browser on the assistant's machine; you sign in yourself, and the assistant never sees your password, codes or CAPTCHAs. **Saved login** attaches a profile you already have. A login lives on the machine where you signed in and can't move; **Sign in on <machine>** creates a new one there. One topic uses a login at a time; another topic waits for it. When a site signs you out, **Sign in** appears in the assistant's activity.
- **Skills and plugins.** Everything active on the assistant's machine is on by default. Turn off what this assistant shouldn't use. **Add skill** gives this assistant a skill of its own, from a folder or a Git repository. Install skills for every conversation in Settings → Resources.
- **Files.** A folder the assistant keeps across all its topics, however a topic started. Upload files for it to use, or ask it to save files here; you can download or delete them.
- **Memory.** Notes the assistant keeps between topics. It reads them before work and adds what's worth keeping, and you can edit them anytime. Turn it off and it stops using them; the notes stay saved.
- **MCP servers.** Choose which installed servers the assistant can call.
- **Secrets.** Attach secret accounts. Values stay in Settings → Secrets and are never shown. The decision model's key can't be detached while that model is selected.

Only your private chat and its topics use these resources. Groups and requests from other people never do.

## Who can find you

Discovery is off until you turn it on. **Findable** is the one switch: on lists you or an assistant on all your relays, and off hides it from everyone at once. Find it under Who can find you, and in each assistant's Settings. While it's on, you can choose relays one by one. Signed-in people on those relays can then find you; nothing is published to the internet.

Hiding stops new direct requests. Groups you're already in and requests already open stay.

A listing shows a name, a description, your home machine and an assistant's public actions. It never includes email, private instructions, credentials, projects, calendar contents or chats. An assistant's listing names you as its owner.

**Find** searches all your active relays at once. The same person found on several relays appears once. A relay that doesn't answer is named, so you know the results are partial.

Account IDs are derived from a person's home machine and username, so every machine checks that a listing, an invitation or a request really comes from that person's home. Use groups and discovery from your home machine.

## Groups

Anyone on a relay can create a group and invite people or assistants. Nobody joins or sees messages until they accept.

- **Your default assistant joins with you** and leaves when you leave. Choose it under Who can find you. It must run on the machine where you accept; otherwise the invitation asks you to switch.
- **An assistant can be invited on its own.** Its owner approves, and the owner doesn't join.
- New members see messages from when they joined, not before.
- The group's creator hosts it on their machine and can remove members or close it. A creator who leaves closes the group. To remove an assistant that joined with its owner, remove the owner.
- If the host machine is offline, your messages wait on your machine and are sent when it's back.

A member assistant reads new messages and tells its owner about what matters. Its owner can review what it saw and decided.

## Direct requests

You can ask someone's assistant for one of its public actions without sharing a group. Each requester gets their own thread. Asking for something that isn't listed gets a reply saying so.

## Reach an assistant from Telegram

A webhook can route calls through an assistant. Each call becomes a message to it, with the same skills, MCP servers, files and memory as your own chat.

To use it from Telegram:

1. Create a bot with [@BotFather](https://t.me/BotFather), and save its token in Settings → Secrets as a secret account with the variable `TELEGRAM_BOT_TOKEN`.
2. On the assistant's chat, choose **Webhook**. Under **Access**, select that secret account and turn on **Reply in Telegram**. To limit who can reach it, turn on **Only listed senders**, choose **Use Telegram bot fields**, and list the Telegram user IDs.
3. Save, copy the webhook's address, and tell Telegram to use it:

   ```
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WEBHOOK_ADDRESS>"
   ```

The webhook's address must be reachable from the internet, for example through a relay.

Each Telegram chat keeps its own conversations. For every message after the first, the decision model (Jev or Laya, as set in Settings) reads what was written and either continues one of that chat's conversations or starts a new one. It doesn't choose from your private chat's topics or from other chats. The answer goes back to the chat, formatted for Telegram. You can read every exchange in the assistant's chat, and a reply that can't be sent is listed in the webhook's Calls.

If the decision model can't answer, the message isn't handled and the chat is told to send it again.

Other webhooks work the same way, without the reply: each sender on the list keeps their own conversations, or the whole webhook shares them when it has no list.

## Public actions

Under **Public actions** you decide what other people may ask your assistant to do:

- **Read free and busy times.** Shares when you're free, never what your meetings are.
- **Create an event.** Books a meeting in your calendar.
- **Share a text I write.** Replies with your exact text, such as travel dates.

Calendar actions use the Google account attached under Resources → Secrets (`GOOGLE_CREDENTIALS_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`; an authorized-user or service-account credential, with `GOOGLE_CALENDAR_ID` and `GOOGLE_CALENDAR_SUBJECT` when needed).

Write the action's instructions in plain language: who it's for and when to ask you first. An action can't be published until you choose what it's allowed to do. **Test** shows the decision without reading or writing your calendar.

### How a request is handled

1. The message is recorded.
2. The **decision model** (TypeSafe or Laya, as set in Settings) decides whether it needs anything and which public action is asked for. The agent never makes this decision.
3. Code reads the day, time and length and builds the exact proposal.
4. The decision model judges that proposal against your instructions: do it, ask you first, or decline.
5. If it asks you first, the exact event and reply appear in the assistant's **Activity**. **Approve once** runs only that proposal. **Edit** makes a new proposal that's checked again. **Reject** does nothing.
6. Just before running, everything is checked again: membership, blocks, and the action and its instructions as they are now. Only the named operation runs.

Public requests never start an agent session, so nothing outside the named operations is reachable. If the decision model doesn't answer, nothing happens. A booked slot that's now taken is not replaced by another one. If a calendar change can't be confirmed, the request is marked **Uncertain** and is never retried automatically; check your calendar and tell the assistant what happened.

### Limits and blocking

By default each person can make 20 requests a day to each assistant, and each assistant makes at most 200 decision checks a day. Change these under Who can find you. Requests over a limit are refused before any model runs. Blocking someone takes effect immediately, including for their requests already in progress.
