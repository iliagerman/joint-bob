# Conversation feedback

Marking a conversation Done offers three choices:

- **Good** or **Bad**: an optional explanation, intended to be one or two sentences (1,000 characters maximum).
- **Nothing — not important**: close the conversation without reading its transcript or calling either model for learning.

For Good/Bad, the conversation summary writer reviews the transcript and drafts a description when the person left it blank. The project's configured decision model reviews the proposed lessons. A supplied rating and description take precedence over inferred ones.

Lessons appear as proposals in **Project knowledge**. They are not installed as rules until a person accepts them. Existing accepted rules and dismissed proposals are not duplicated. Running summaries can still propose rules during a conversation, subject to the same manual acceptance. Marking a conversation unimportant stops subsequent summary updates from recording knowledge; it does not undo rules already accepted.

## Inactive conversations

The execution node checks once an hour, beginning a minute after startup. Conversations owned by this node, not running and not already Done, are eligible after **more than four days** without a timestamped user or assistant message. File modification, sync and summary timestamps do not count. Missing message timestamps do not prove inactivity.

Eligible conversations are marked Done and sent for automatic Good/Bad/Not important classification. Not important skips generation and lesson review. A new interaction during classification cancels its result and reopens the conversation. A newer manual rating or reopen invalidates an older in-flight review.

## Recovery and visibility

Feedback, its source and processing state replicate with conversation metadata. Pending and failed reviews are retried by the owning node on its hourly sweep, including after restart. A missing decision model or failed agent call remains an explicit error rather than an invented classification. The Done badge shows learning failures; its tooltip contains the description and error.

Marking a conversation Done answers at once, with or without a description: the conversation is done before anything is learned from it. For Good/Bad, the learning (the summary writer's draft, then the decision model's review of lessons) runs after the answer, which can take up to a minute; the badge says *Done · learning…* until it finishes. The page that marked it says once how it went: *Feedback reviewed* or, as an error, *Conversation is done, but learning failed: …*.

Worktree cleanup waits while the project has unfinished feedback, so a failed review does not lose the transcript it needs to retry; it runs once a background review finishes and none is left unfinished. Reopening clears the closeout record; marking Done again permits new feedback.

## Focused tests

```sh
npm run test:file -- test/conversation-closeout.test.ts test/conversation-closeout-runtime.test.ts
npm run test:file -- test/ui/ui-chat-done-button.test.ts test/ui/ui-conversation-done.test.ts test/ui/ui-chat-menu-parity.test.ts test/ui/ui-optimistic-actions.test.ts
npm run typecheck
```
