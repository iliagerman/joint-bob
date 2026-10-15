# Conversation links and PWA shortcuts

Open a conversation, then choose **Share** from its More menu. Joint Bob opens
native sharing when the browser supports it; otherwise it copies the link to the
clipboard. A cancelled share does nothing. Failed sharing or clipboard access
shows an error.

The link identifies the conversation, project and execution node. It contains no
transcript content, credentials or local file path. Opening it still requires
sign-in and the normal project permissions. Sharing a link does not grant access.
The project and conversation must be available on the node serving the link.

You can bookmark a conversation link. Joint Bob does not install a separate app
icon for each conversation. Browser and operating-system support determines
whether links open inside an installed Joint Bob app.

Installed apps on browsers that support manifest shortcuts offer **New
Conversation** in the app icon's menu. This opens the new-conversation wizard
after sign-in, rather than restoring the last conversation. It does not send a
message automatically.

The service worker caches the application shell, not conversation transcripts.
Reading or continuing conversations still requires the node to be reachable.
Joint Bob does not register as an incoming share target.

## Link parameters

- `sessionId`: conversation ID.
- `projectId`: project ID.
- `nodeId`: execution node ID.
- `sessionPath`: optional legacy session path, not included by Share.

The new-conversation app shortcut uses `/?action=new-conversation`.

## Verification

```sh
npm run test:file -- test/ui/ui-conversation-sharing.test.ts
```
