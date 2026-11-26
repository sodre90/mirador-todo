# To-do for Mirador

A Mirador workspace-tab plugin (plugin API 25). See README.md for what it does and how to run it.

- Bun and TypeScript for the host code, strict; imports carry their `.ts` extensions. The view is plain JavaScript in `view.js`, with no build step.
- `bun run typecheck` and `bun run test` (not a bare `bun test`, which would pick up the Playwright spec) before every commit, and the e2e in a Mirador checkout for anything the user sees.
- `mirador/api.ts` is a copy of Mirador's `shared/canvas-plugins.ts`. Take it again from Mirador when the plugin moves to a newer API, rather than editing it by hand.
- Every to-do lives under one plugin-wide storage key (`todos`), each carrying its `workspaceId`. A tool's context knows only its own workspace and storage can't list keys, so per-workspace keys would hide the other workspaces from `todo_list`'s `all_workspaces`. The tab reads that key through `sharedStorage`.
- A tool's change redraws its workspace's tab through the background context kept in `host.ts` (`watchWorkspaces`), since a tool's context has no `changed()`.
- `when.ts` finds the time in a to-do's line or due field; Mirador reads the words themselves through the context's `readTime` and `morningMinutes` (plugin API 25), as `/remind` does. Unit tests give the fake context `tests/times.ts`, a table of the phrases they use; the e2e reads them with Mirador's own parser.
- `ring.ts` rings for due to-dos through `notify` (plugin API 24), from a timer `background` starts: it wakes at the next due time, or every 30 seconds at most, so a to-do still rings soon after the Mac sleeps. `rungFor` holds the due time a to-do last rang for; a due time already past as it's set is marked rung. Every change through a tool or the tab re-times the timer.
- The tab's picker asks `host.ts` for its quick picks and the user's morning (`picks`) as Mirador first sends the tab its state, every minute, as the user comes back to the tab or its line, and as a calendar opens: Mirador doesn't send the tab its state again when the morning changes in its settings.
- `host.ts` keeps the agent's text as written; only the user's slash command and the tab read a time out of the words.
- The plugin gives `guidance.summary`, so it loads on request and its tools run through `use_tool`. Keep the instructions line short; every conversation that loads it pays for it.
- Names over comments: keep comments for a genuine "why" that a name can't carry.
- Every change comes with tests: logic gets unit tests, and what the user sees gets e2e coverage.
- Words the user or the agent reads: plain words and sentence case.
- Commits: authored by the owner only, with no AI attribution or trailers. One plain sentence saying what the user gets.
- Releases: bump `version` in `plugin.json` and tag the commit `v<version>`; Mirador refuses a tag that doesn't match.
