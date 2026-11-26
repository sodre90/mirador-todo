import type { PluginBackgroundContext, PluginNotificationText } from "./mirador/api.ts";
import { dueWords, saveTodos, todosIn, type Todo } from "./todos.ts";

/** The longest the ringer sleeps between looks, so a to-do still rings soon after the Mac wakes or its clock moves. */
export const LOOK_AGAIN_MS = 30_000;

const isOpen = (todo: Todo) => todo.doneAt === null;
const notRungFor = (todo: Todo) => todo.dueAt !== null && todo.rungFor !== todo.dueAt;
const isDueBy = (now: number) => (todo: Todo) => isOpen(todo) && notRungFor(todo) && todo.dueAt! <= now;

/** What the user is told of the to-dos of one workspace that came due together. */
export function ringText(due: Todo[], now: Date): PluginNotificationText {
  if (due.length > 1) return { title: `${due.length} to-dos are due`, body: due.map(({ text }) => text).join(" · ") };
  const [todo] = due as [Todo];
  return { title: todo.text, body: [`Due ${dueWords(todo.dueAt!, now)}`, todo.note].filter(Boolean).join(" · ") };
}

function untilNextDue(todos: Todo[], now: number): number {
  const comingUp = todos.filter((todo) => isOpen(todo) && notRungFor(todo) && todo.dueAt! > now).map(({ dueAt }) => dueAt! - now);
  return Math.min(LOOK_AGAIN_MS, ...comingUp);
}

/**
 * Tells the user of each open workspace's to-dos that have come due and haven't rung for that time, in one notification
 * per workspace, and marks them rung. Returns how long to sleep before looking again.
 */
export function ringDue(context: PluginBackgroundContext, now = Date.now()): number {
  const todos = todosIn(context.storage);
  const openWorkspaces = new Set(context.workspaces().map(({ id }) => id));
  const due = todos.filter(isDueBy(now)).filter(({ workspaceId }) => openWorkspaces.has(workspaceId));
  const rung = new Set<string>();
  for (const [workspaceId, together] of Map.groupBy(due, ({ workspaceId }) => workspaceId)) {
    try {
      context.inWorkspace(workspaceId).notify(ringText(together, new Date(now)));
      together.forEach(({ id }) => rung.add(id));
    } catch (error) {
      console.error(`To-do couldn't ring for ${workspaceId}:`, error);
    }
  }
  if (rung.size > 0) saveTodos(context.storage, todos.map((todo) => (rung.has(todo.id) ? { ...todo, rungFor: todo.dueAt! } : todo)), now);
  return untilNextDue(todos, now);
}

let sleeping: ReturnType<typeof setTimeout> | undefined;

/** Rings what's due now, then sleeps until the next to-do comes due, or for a while at most; null stops it. */
export function keepRinging(context: PluginBackgroundContext | null) {
  clearTimeout(sleeping);
  if (!context) return;
  let wait = LOOK_AGAIN_MS;
  try {
    wait = ringDue(context);
  } catch (error) {
    console.error("To-do couldn't look for what's due:", error);
  }
  sleeping = setTimeout(() => keepRinging(context), wait);
}
