import type { CanvasHost, CanvasPluginStorage, CanvasToolContext, PluginBackgroundContext, PluginWorkspace, WorkspaceTabContext } from "./mirador/api.ts";
import { changed, doneOf, inWorkspace, newTodo, openOf, saveTodos, todoLine, todoNamed, todosIn, type Todo, type TodoChange } from "./todos.ts";
import { readDue, readTodoLine } from "./when.ts";

/** The done to-dos the tab lists, the latest first. */
const DONE_SHOWN = 20;
/** How far back todo_list looks for done ones, when asked for them. */
const DONE_LISTED_MS = 7 * 24 * 60 * 60 * 1000;

/** Mirador's workspaces, kept from `background` so a tool's change can redraw its workspace's tab. */
let opened: PluginBackgroundContext | null = null;

export function watchWorkspaces(context: PluginBackgroundContext | null) {
  opened = context;
}

/** Redraws the workspace's tab, wherever it's open; nothing to redraw for a workspace Mirador has closed. */
function tabChanged(workspaceId: string) {
  try {
    opened?.inWorkspace(workspaceId).changed();
  } catch {
    // The workspace isn't open, so no tab shows it.
  }
}

/** The to-dos with each workspace's name as Mirador has it now. */
function withNamesNow(todos: Todo[]): Todo[] {
  const names = new Map((opened?.workspaces() ?? []).map(({ id, name }) => [id, name]));
  return todos.map((todo) => ({ ...todo, workspaceName: names.get(todo.workspaceId) ?? todo.workspaceName }));
}

function changeTodo(storage: CanvasPluginStorage, id: string, change: TodoChange): Todo {
  const todos = todosIn(storage);
  const todo = changed(todoNamed(todos, id), change);
  saveTodos(storage, todos.map((each) => (each.id === id ? todo : each)));
  return todo;
}

function deleteTodo(storage: CanvasPluginStorage, id: string): Todo {
  const todos = todosIn(storage);
  const todo = todoNamed(todos, id);
  saveTodos(storage, todos.filter((each) => each.id !== id));
  return todo;
}

function addTodo(storage: CanvasPluginStorage, todo: Todo): Todo {
  saveTodos(storage, [...todosIn(storage), todo]);
  return todo;
}

/** A due time the agent or the user wrote: null for none, else read as ISO 8601 or plain words. */
const dueFrom = (due: string | null | undefined, now: Date) => (due === undefined || due === null || due.trim() === "" ? null : readDue(due, now));

interface AddInput {
  text: string;
  due?: string;
  note?: string;
}

/** The user's slash command may say when in its text; the agent says it in `due`. */
function writtenBy(input: AddInput, caller: CanvasToolContext["caller"], now: Date) {
  if (input.due === undefined && caller === "user") return readTodoLine(input.text, now);
  return { text: input.text, dueAt: dueFrom(input.due, now) };
}

const where = (workspace: PluginWorkspace) => `the To-do tab of ${workspace.name}`;

function addTool(input: unknown, context: CanvasToolContext): string {
  const now = new Date();
  const written = writtenBy(input as AddInput, context.caller, now);
  const todo = addTodo(context.storage, newTodo(context.workspace, { ...written, note: (input as AddInput).note }, now.getTime()));
  tabChanged(todo.workspaceId);
  return `Added to ${where(context.workspace)}:\n${todoLine(todo, now, { withWorkspace: false })}`;
}

interface ListInput {
  all_workspaces?: boolean;
  include_done?: boolean;
}

function listTool(input: unknown, context: CanvasToolContext): string {
  const { all_workspaces = false, include_done = false } = input as ListInput;
  const now = new Date();
  const todos = withNamesNow(todosIn(context.storage));
  const shown = all_workspaces ? todos : inWorkspace(todos, context.workspace.id);
  const scope = all_workspaces ? "every workspace" : context.workspace.name;
  const lines = (list: Todo[]) => list.map((todo) => todoLine(todo, now, { withWorkspace: all_workspaces })).join("\n");
  const open = openOf(shown);
  const openPart = open.length === 0 ? `No open to-dos in ${scope}.` : `Open to-dos in ${scope}, the soonest due first (${open.length}):\n${lines(open)}`;
  if (!include_done) return openPart;
  const done = doneOf(shown).filter(({ doneAt }) => now.getTime() - doneAt! < DONE_LISTED_MS);
  return `${openPart}\n\n${done.length === 0 ? "None done in the last 7 days." : `Done in the last 7 days (${done.length}):\n${lines(done)}`}`;
}

interface UpdateInput {
  id: string;
  done?: boolean;
  text?: string;
  due?: string | null;
  note?: string | null;
  delete?: boolean;
}

function updateTool(input: unknown, context: CanvasToolContext): string {
  const { id, done, text, due, note, delete: deleting } = input as UpdateInput;
  const now = new Date();
  if (deleting) {
    const gone = deleteTodo(context.storage, id);
    tabChanged(gone.workspaceId);
    return `Deleted: ${gone.text}`;
  }
  const todo = changeTodo(context.storage, id, { done, text, note, ...(due !== undefined && { dueAt: dueFrom(due, now) }) });
  tabChanged(todo.workspaceId);
  return `Now:\n${todoLine(todo, now, { withWorkspace: todo.workspaceId !== context.workspace.id })}`;
}

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const DUE_DESCRIPTION =
  'When it\'s due: ISO 8601 with the offset, e.g. "2026-11-28T14:00:00+01:00", a date alone for its morning, or plain English words such as "fri 14:00", "tomorrow" or "in 3h".';

/** What the tab draws: the workspace's open to-dos and its latest done ones. */
export interface TabState {
  workspace: string;
  open: Todo[];
  done: Todo[];
}

export function tabState(context: WorkspaceTabContext): TabState {
  const here = inWorkspace(todosIn(context.sharedStorage), context.workspace.id);
  return { workspace: context.workspace.name, open: openOf(here), done: doneOf(here).slice(0, DONE_SHOWN) };
}

export type TabAction =
  | { kind: "read"; line: string }
  | { kind: "add"; line: string; dueAt: number | null; readsTime: boolean }
  | { kind: "change"; id: string; text?: string; note?: string | null; dueAt?: number | null }
  | { kind: "done"; id: string; done: boolean }
  | { kind: "delete"; id: string }
  | { kind: "restore"; todo: Todo };

/** The line as typed, with the time its words name unless the user picked one or chose to keep the words. */
function lineToAdd(action: Extract<TabAction, { kind: "add" }>, now: Date) {
  if (action.dueAt !== null) return { text: action.line, dueAt: action.dueAt };
  return action.readsTime ? readTodoLine(action.line, now) : { text: action.line, dueAt: null };
}

function tabAction(action: unknown, context: WorkspaceTabContext): unknown {
  const asked = action as TabAction;
  const storage = context.sharedStorage;
  const now = new Date();
  const answer = (() => {
    switch (asked.kind) {
      case "read":
        return readTodoLine(asked.line, now);
      case "add":
        return addTodo(storage, newTodo(context.workspace, lineToAdd(asked, now), now.getTime()));
      case "change": {
        const { id, kind: _, ...change } = asked;
        return changeTodo(storage, id, change);
      }
      case "done":
        return changeTodo(storage, asked.id, { done: asked.done });
      case "delete":
        return deleteTodo(storage, asked.id);
      case "restore":
        return addTodo(storage, { ...asked.todo, workspaceId: context.workspace.id, workspaceName: context.workspace.name });
    }
  })();
  if (asked.kind !== "read") context.changed();
  return answer;
}

/**
 * To-do: the user's own to-dos for each workspace, kept in Mirador. The workspace's To-do tab lists and edits them, and
 * the agent reaches them through tools, loaded when a conversation needs them: in one workspace, or in all of them for
 * a morning's overview.
 */
const host: CanvasHost = {
  items: {},
  tools: {
    todo_add: {
      description: "Adds a to-do to the user's list for this conversation's workspace, shown in its To-do tab.",
      input: {
        type: "object",
        $schema: SCHEMA,
        properties: {
          text: { type: "string", minLength: 1, description: "What there is to do, in a short line." },
          due: { type: "string", description: `${DUE_DESCRIPTION} Leave it out for a to-do with no time.` },
          note: { type: "string", description: "More about it, such as a link to its ticket or pull request." },
        },
        required: ["text"],
      },
      command: { description: 'Add a to-do to this workspace, its time in words at the end of the text: text="send the summary fri 14:00"' },
      run: addTool,
    },
    todo_list: {
      description: "Lists the user's open to-dos, the soonest due first, with their ids: this workspace's, or every workspace's.",
      input: {
        type: "object",
        $schema: SCHEMA,
        properties: {
          all_workspaces: { type: "boolean", description: "Every workspace's to-dos, each with its workspace's name, e.g. for a morning overview. False by default." },
          include_done: { type: "boolean", description: "Also those done in the last 7 days. False by default." },
        },
      },
      run: listTool,
    },
    todo_update: {
      description: "Ticks off, reopens, rewords, reschedules or deletes one of the user's to-dos, by the id todo_list gives.",
      input: {
        type: "object",
        $schema: SCHEMA,
        properties: {
          id: { type: "string", minLength: 1 },
          done: { type: "boolean", description: "True ticks it off, false opens it again." },
          text: { type: "string", minLength: 1 },
          due: { type: ["string", "null"], description: `${DUE_DESCRIPTION} Null takes its time off.` },
          note: { type: ["string", "null"], description: "Null takes the note off." },
          delete: { type: "boolean", description: "True deletes it; the user can't undo that from here." },
        },
        required: ["id"],
      },
      run: updateTool,
    },
  },
  guidance: {
    summary: "the user's own to-dos for each workspace, kept in Mirador; when the user asks to note a task or be reminded of one, or for a day's overview of what's open.",
    instructions:
      "- todo_add, todo_list, todo_update: the user's own to-dos for each workspace, shown in its To-do tab. Add one when the user asks to note a task or be reminded of one; list every workspace's for a day's overview. They aren't your plan of steps (that's checklist), nor a way to come back to this conversation later (that's the user's /remind).",
  },
  workspaceTab: { state: tabState, action: tabAction },
  background(context) {
    watchWorkspaces(context);
  },
};

export default host;
