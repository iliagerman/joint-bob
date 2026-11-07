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

Your private chat, its topics and Telegram use these resources. Relay groups and direct requests from other people never do.

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

When a message expects a reply from you, the assistant writes a draft and puts it in **Activity**. Choose **Post**, **Edit** or **Discard**; nothing is sent until you post it. Drafts are written from your instructions and memory, with every tool removed, so a message can't make the assistant run anything. The draft can't look things up, such as your calendar. Each draft counts as a decision check toward your daily limit. Direct requests work the same way.

## Direct requests

You can ask someone's assistant for one of its public actions without sharing a group. Each requester gets their own thread. Asking for something that isn't listed gets a reply saying so.

## Telegram

An assistant can have its own Telegram bot. Connect it under **Resources → Telegram**:

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot` and copy the token.
2. Paste the token and choose **Connect**. Joint Bob sets up the bot for you. The machine needs an address Telegram can reach, such as a relay.
3. Open the one-time link you get, to link your own Telegram account. It works once and expires after 10 minutes. Until you link one, the bot answers nobody.

**Who shares what:**

- **Your own private chat with the bot** is the same assistant as the app, so it can continue what you started there.
- **A Telegram group** is one shared context for everyone in it, separate from your private conversations. The decision model decides whether each message is for the assistant. If it is, the answer posts directly to the group; other messages stay as context.
- **Someone else you approve** gets their own conversations in their private chat with the bot.

To let the bot read a whole group, turn off its privacy mode in @BotFather with `/setprivacy` and add it to the group again, or make it a group admin. Otherwise it only sees commands and replies to it.

**Who can reach it.** Code checks every message before the decision model or an agent runs:

- Each call must carry a secret that Joint Bob gave Telegram when connecting. Anything else is refused.
- A private chat works only for you and people you approve. Anyone else gets one "This bot is private" reply and appears under **Waiting for approval**.
- A group works only if you approved it. Adding the bot to a group yourself approves it. If anyone else adds it, the bot leaves and the group waits for your approval.
- Only Joint Bob uses the bot's token. The agent can't read it.
- A message Telegram sends twice is handled once.
- Removing or blocking someone applies from their next message.

Everyone in an approved group can use what the assistant can use, including its tools, secrets, files and memory, and can ask about them. That includes people who join later; you get a notice when someone joins. For a group with other people, connect a separate assistant that has only what you're happy to share. Anyone who takes over your Telegram account becomes you to the bot, so turn on Telegram's two-step verification.

If the decision model can't answer, a private chat is told to send the message again, and a group gets no reply.

### Voice, photos and files

- **Voice messages and round video messages** are transcribed in any language, so the decision model and the agent read the words. Audio files are transcribed too, and the agent gets both the file and its words, up to the first 10 minutes.
- **Voice messages get a voice reply by default.** Turn this off under **Resources → Telegram → Voice messages**. The answer also comes as text if it holds code, links or a table, and only as text if it would run over about a minute or nothing here can speak it.
- **Photos and files of any type** reach the agent with the message. An album counts as one message. Replying to an older file gives the agent that file too.
- **In a group,** files are fetched only when the assistant answers. Its answer comes with any files from the last 20 messages that it hasn't received yet, up to 10.
- **Sending files back:** the agent saves them in a folder Joint Bob gives it for that turn, and they're posted after its answer. Images go as photos, `.ogg` files as voice messages, `.mp3` and `.m4a` as audio, `.mp4` as video and anything else as a document.

Voice needs one of these. You don't need ElevenLabs if your machine can run the open-source voice:

- **Open-source voice:** choose **Install open-source voice** under **Resources → Telegram**. It runs on this machine, sends nothing out, needs at least 8 GB of memory and 4 cores, and takes about 800 MB. Whisper understands any language it's spoken to in, but Kokoro only speaks English, so an answer in another language comes as text. On a four-core machine, Whisper takes about as long as the audio and speaking an answer takes about twice its length, and both use every core while they run. Whisper also uses over 1 GB of memory.
- **ElevenLabs:** attach an ElevenLabs account to the assistant's project in **Settings → Secrets**. If the open-source voice isn't installed, audio is sent to ElevenLabs to be transcribed. In a group, that's every voice message the bot can see. Answers in English use the open-source voice if it's installed; other languages use ElevenLabs if an account is attached.
- **Neither:** the agent gets the audio file and answers in text. In a group, the decision model can't tell whether a voice message is for the assistant.

**Settings → Activity overview** chooses the voice and which engine speaks.

Telegram limits bots to downloading files up to 20 MB and sending up to 50 MB. If a file is too large, the chat is told. Stickers reach the agent as their emoji. Contacts, locations and polls aren't read.

## Other webhooks

A webhook can also route calls through an assistant, with the same skills, MCP servers, files and memory as your own chat. Each sender on its list keeps their own conversations, or the whole webhook shares them when it has no list. The decision model continues one of those conversations or starts a new one, and the answer stays in Joint Bob.

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
