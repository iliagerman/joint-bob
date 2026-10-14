# Auto respond

Auto respond answers for you when the agent stops. Turn it on from a conversation's
**Auto respond** action (the toolbar, or More on a narrow window). Pick the harness,
model and effort of the responder, write its instructions and its stop instructions,
and optionally limit the responses in a row.

While it is on, each time the agent's turn ends with nothing queued and nothing still
running in the background, a second model reads the conversation, checks the stop
instructions first, and either writes the next user message or stops. The reply is
queued like any message you type and appears with an **Auto** badge.

It stops when:

- a stop instruction holds (the responder gives the reason),
- the limit is reached,
- you press Stop on the turn,
- the agent's turn fails, or the responder fails or no budget is left.

A stopped responder stays stopped until you save the dialog again with the box ticked,
which also restarts the count and judges the agent's last message afresh. A message you
type runs first and restarts the count; it does not pause auto respond.

By default the responder works in the project folder with its harness's tools: it reads
the files the agent changed, looks at git status and diffs, and runs the tests or commands
the agent says pass, before it answers. It is told not to change anything (no edits,
commits, pushes, deploys or installs); that is a prompt rule, not a sandbox, because the
harnesses expose tools differently. Untick **Let the responder read files and run
commands** to make it judge the agent's text only. A responder with tools may take up to
20 minutes per decision; one without, two.

The default instructions also tell it to check claims and, when a change cannot be checked
with what exists (a UI, an API flow, an integration with no test), to ask the agent for a
way to test it (a test, a script, a test page, a fixture server or a browser check) and to
run it. All instructions are prefilled and can be edited per conversation. Its reply
reaches the agent as an ordinary user message.

The setting belongs to this node and runs only where the conversation is owned. It is
not replicated to twins. The Auto badge is kept on this node, so a reopened conversation
still marks the replies the responder wrote.

`/bob-goal` and auto respond can both be set: the goal runs first, and once it
completes or blocks the responder takes the next stop.
