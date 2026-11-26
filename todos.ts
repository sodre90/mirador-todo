import type { CanvasPluginStorage, PluginWorkspace } from "./mirador/api.ts";

/** Something the user wants to get done in a workspace's project, and when. */
export interface Todo {
  id: string;
  workspaceId: string;
  /** The workspace's name when last seen, to tell it by once Mirador no longer has it open. */
  workspaceName: string;
  text: string;
  /** More about it, such as a link to its ticket. */
  note: string | null;
  /** When it's due, in milliseconds since the epoch. */
  dueAt: number | null;
  createdAt: number;
  doneAt: number | null;
  /** The due time it last rang for, so it rings once for each time it's given. */
  rungFor?: number;
}

/** What changes in a to-do; null takes a note or a due time off. */
export interface TodoChange {
  text?: string;
  note?: string | null;
  dueAt?: number | null;
  done?: boolean;
}

const TODOS_KEY = "todos";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Done to-dos stay this long, for the tab's Done list and for Undo. */
export const DONE_KEPT_MS = 30 * DAY_MS;
export const MAX_TEXT_LENGTH = 500;
export const MAX_NOTE_LENGTH = 2000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Every workspace's to-dos, under one key, so a tool in one workspace can list them all. */
export const todosIn = (storage: CanvasPluginStorage) => (storage.get(TODOS_KEY) ?? []) as Todo[];

const keptAfter = (now: number) => (todo: Todo) => todo.doneAt === null || now - todo.doneAt < DONE_KEPT_MS;

export const saveTodos = (storage: CanvasPluginStorage, todos: Todo[], now = Date.now()) => storage.set(TODOS_KEY, todos.filter(keptAfter(now)));

function checkedText(text: string): string {
  const written = text.trim().replace(/\s+/g, " ");
  if (written === "") throw new Error("Write what there is to do.");
  if (written.length > MAX_TEXT_LENGTH) throw new Error(`Keep a to-do under ${MAX_TEXT_LENGTH} characters; put the rest in its note.`);
  return written;
}

function checkedNote(note: string | null | undefined): string | null {
  const written = note?.trim() ?? "";
  if (written.length > MAX_NOTE_LENGTH) throw new Error(`Keep a note under ${MAX_NOTE_LENGTH} characters.`);
  return written === "" ? null : written;
}

/** A due time already past as it's set doesn't ring: the user is looking at it. */
const rungIfPast = (dueAt: number | null, now: number) => (dueAt !== null && dueAt <= now ? { rungFor: dueAt } : {});

export function newTodo(workspace: PluginWorkspace, written: { text: string; note?: string | null; dueAt?: number | null }, now = Date.now()): Todo {
  return {
    id: crypto.randomUUID(),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    text: checkedText(written.text),
    note: checkedNote(written.note),
    dueAt: written.dueAt ?? null,
    createdAt: now,
    doneAt: null,
    ...rungIfPast(written.dueAt ?? null, now),
  };
}

export function changed(todo: Todo, change: TodoChange, now = Date.now()): Todo {
  return {
    ...todo,
    ...(change.text !== undefined && { text: checkedText(change.text) }),
    ...(change.note !== undefined && { note: checkedNote(change.note) }),
    ...(change.dueAt !== undefined && { dueAt: change.dueAt, ...rungIfPast(change.dueAt, now) }),
    ...(change.done !== undefined && { doneAt: change.done ? (todo.doneAt ?? now) : null }),
  };
}

/** The one with that id; throws, for the agent or the tab, when there's none. */
export function todoNamed(todos: Todo[], id: string): Todo {
  const todo = todos.find((each) => each.id === id);
  if (!todo) throw new Error(`There's no to-do ${id} any more. List them again to get their ids.`);
  return todo;
}

const byDueThenAge = (one: Todo, other: Todo) =>
  (one.dueAt ?? Number.POSITIVE_INFINITY) - (other.dueAt ?? Number.POSITIVE_INFINITY) || one.createdAt - other.createdAt;

/** The open ones, the soonest due first and those with no time last, oldest first among equals. */
export const openOf = (todos: Todo[]) => todos.filter(({ doneAt }) => doneAt === null).sort(byDueThenAge);

/** The done ones, the latest done first. */
export const doneOf = (todos: Todo[]) => todos.filter(({ doneAt }) => doneAt !== null).sort((one, other) => other.doneAt! - one.doneAt!);

export const inWorkspace = (todos: Todo[], workspaceId: string) => todos.filter((todo) => todo.workspaceId === workspaceId);

const pad = (number: number) => String(number).padStart(2, "0");
const clockOf = (time: Date) => `${pad(time.getHours())}:${pad(time.getMinutes())}`;
const startOfDay = (time: Date) => new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();

/** How a due time reads beside a to-do: "today 14:00", "tomorrow 09:00", "Fri 28 Nov 14:00". */
export function dueWords(dueAt: number, now: Date): string {
  const due = new Date(dueAt);
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday" : `${WEEKDAYS[due.getDay()]} ${due.getDate()} ${MONTHS[due.getMonth()]}`;
  return `${day} ${clockOf(due)}`;
}

export type Urgency = "overdue" | "today" | "later" | "none";

export function urgencyOf(todo: Todo, now: Date): Urgency {
  if (todo.dueAt === null) return "none";
  if (todo.dueAt <= now.getTime()) return "overdue";
  return startOfDay(new Date(todo.dueAt)) === startOfDay(now) ? "today" : "later";
}

/** A due time as the agent reads it: ISO 8601 in the Mac's own time zone. */
export function localIso(time: number): string {
  const at = new Date(time);
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${clockOf(at)}:00${zone}`;
}

/** One to-do on a line for the agent: its id, when it's due, its text and note, and its workspace when several are listed. */
export function todoLine(todo: Todo, now: Date, { withWorkspace }: { withWorkspace: boolean }): string {
  const due = todo.dueAt === null ? "no due time" : `due ${localIso(todo.dueAt)} (${urgencyOf(todo, now) === "overdue" ? "overdue, " : ""}${dueWords(todo.dueAt, now)})`;
  const done = todo.doneAt === null ? "" : `, done ${localIso(todo.doneAt)}`;
  const where = withWorkspace ? ` [${todo.workspaceName}]` : "";
  const note = todo.note ? `\n    note: ${todo.note.replace(/\n/g, "\n    ")}` : "";
  return `- ${todo.id}${where}: ${todo.text} (${due}${done})${note}`;
}
