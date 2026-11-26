# To-do for Mirador

A Mirador workspace-tab plugin (plugin API 23). See README.md for what it does and how to run it.

- Bun and TypeScript for the host code, strict; imports carry their `.ts` extensions. The view is plain JavaScript in `view.js`, with no build step.
- `bun run typecheck` and `bun run test` (not a bare `bun test`, which would pick up the Playwright spec) before every commit, and the e2e in a Mirador checkout for anything the user sees.
- `mirador/api.ts` is a copy of Mirador's `shared/canvas-plugins.ts`. Take it again from Mirador when the plugin moves to a newer API, rather than editing it by hand.
- Every to-do lives under one plugin-wide storage key (`todos`), each carrying its `workspaceId`. A tool's context knows only its own workspace and storage can't list keys, so per-workspace keys would hide the other workspaces from `todo_list`'s `all_workspaces`. The tab reads that key through `sharedStorage`.
- A tool's change redraws its workspace's tab through the background context kept in `host.ts` (`watchWorkspaces`), since a tool's context has no `changed()`.
- `when.ts` holds a copy of the time-word parser of Mirador's `shared/reminders.ts` (`parseReminderTime`), which plugins can't import. Keep the two in step, and keep the words English, as `/remind`'s are.
- `host.ts` keeps the agent's text as written; only the user's slash command and the tab read a time out of the words.
- The plugin gives `guidance.summary`, so it loads on request and its tools run through `use_tool`. Keep the instructions line short; every conversation that loads it pays for it.
- Names over comments: keep comments for a genuine "why" that a name can't carry.
- Every change comes with tests: logic gets unit tests, and what the user sees gets e2e coverage.
- Words the user or the agent reads: plain words and sentence case.
- Commits: authored by the owner only, with no AI attribution or trailers. One plain sentence saying what the user gets.
- Releases: bump `version` in `plugin.json` and tag the commit `v<version>`; Mirador refuses a tag that doesn't match.
