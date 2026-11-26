# To-do

A [Mirador](https://github.com/sodre90/mirador) plugin for your own to-dos in each workspace. They're kept in Mirador
itself, with no account or service to sign in to.

The workspace's **To-do** tab lists what's open, the soonest due first, in groups: Overdue, Today, Coming up and No
time. To add one, type a line with its time in plain words at the end or the start, such as "send the summary fri
14:00", "call the bank tomorrow" or "in 3h check the build". A preview shows the time it read. **Keep the words** adds
the line as typed, and the time picker sets a time of your own. A lone number such as "java 21" stays part of the text.
Tick one off and it moves to Done; Undo brings it back. Edit changes its text, note and time, and Delete has an Undo
too. Done to-dos are kept for 30 days.

When a to-do comes due, Mirador tells you: a notification on this computer, and on your phone if the Mirador app there
lets plugins' notifications through. Those of one workspace that come due together share one notification. Each to-do
rings once for its time, and again only when you give it a new one; one that came due while Mirador was closed rings as
it starts. A time that has already passed when you set it doesn't ring.

Mirador reads the words, as its `/remind` does, in English: `9`, `14:30`, `2pm`, `noon`, `tomorrow`, `mon`…`sun`,
`tonight`, `next week`, `in 30 min`, `3h`, `2d`. A day without a time means your morning, as set for reminders in
Mirador (09:00 unless you changed it), and "today" means the evening (18:00).

## For agents

The plugin loads on request, so its tools cost a conversation nothing until it needs them. A conversation is told in one
line that the user's to-dos are here, and reaches the tools through `use_tool`:

- `todo_add`: adds a to-do to the conversation's workspace, with an optional due time (ISO 8601, or plain words) and note.
- `todo_list`: the open ones of this workspace, or of every workspace with `all_workspaces`, the soonest due first, with
  their ids; `include_done` adds those done in the last 7 days.
- `todo_update`: ticks off, reopens, rewords, reschedules or deletes one by its id.

So "remind me to send the summary on Friday" works in any conversation, and a morning routine can call `todo_list` with
`all_workspaces` for the day ahead. You can also add one from the slash menu, without the agent:
`/todo:todo_add text="send the summary fri 14:00"`.

## Develop

    bun install
    bun run test          # the time words, the tools and the tab's actions
    bun run typecheck

`e2e/todo-plugin.spec.ts` drives the tab, the tools and the slash command in a real Mirador. It needs Mirador's own e2e
helpers, so it runs from a Mirador checkout, as its header says.

Try it in your own Mirador:

    ln -s "$PWD" ~/.mirador/plugins/todo

Mirador loads it from its next start (`⌘⇧R` in a conversation on this computer).
