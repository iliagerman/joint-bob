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

The responder has no tools: it judges only what the agent wrote. Its reply reaches the
agent as an ordinary user message. The default stop instructions cover credentials,
destructive actions and being blocked; edit them to suit the conversation.

The setting belongs to this node and runs only where the conversation is owned. It is
not replicated to twins. The Auto badge is kept on this node, so a reopened conversation
still marks the replies the responder wrote.

`/bob-goal` and auto respond can both be set: the goal runs first, and once it
completes or blocks the responder takes the next stop.
