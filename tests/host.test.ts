import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import host, { tabState, watchWorkspaces, type TabAction } from "../host.ts";
import type { CanvasToolContext, PluginBackgroundContext, PluginWorkspace, ToolCaller, WorkspaceTabContext } from "../mirador/api.ts";
import { LOOK_AGAIN_MS, ringDue } from "../ring.ts";
import { DONE_KEPT_MS, newTodo, saveTodos, todosIn, type Todo } from "../todos.ts";

/** Thursday 26 November 2026, 10:30 on the Mac's own clock. */
const NOW = new Date(2026, 10, 26, 10, 30);
const at = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 10, day, hour, minute, second).getTime();

const kernel: PluginWorkspace = { id: "w-kernel", name: "kernel", folder: "/work/kernel" };
const website: PluginWorkspace = { id: "w-site", name: "website", folder: "/work/site" };

/** The plugin's storage across workspaces, as one plain object, with each workspace's tab counting its redraws and keeping what it was told. */
function fakeMirador() {
  const kept: Record<string, unknown> = {};
  const storage = { get: (key: string) => kept[key], set: (key: string, value: unknown) => void (kept[key] = value) };
  const redraws = new Map<string, number>();
  const told: { workspace: string; title: string; body: string }[] = [];
  const tabOf = (workspace: PluginWorkspace) =>
    ({
      workspace,
      storage: { get: () => undefined, set: () => undefined },
      sharedStorage: storage,
      changed: () => redraws.set(workspace.id, (redraws.get(workspace.id) ?? 0) + 1),
      notify: (said: { title: string; body: string }) => void told.push({ workspace: workspace.name, ...said }),
    }) as unknown as WorkspaceTabContext;
  const background = {
    workspaces: () => [kernel, website],
    inWorkspace: (id: string) => {
      const workspace = [kernel, website].find((each) => each.id === id);
      if (!workspace) throw new Error(`No workspace ${id} is open in Mirador.`);
      return tabOf(workspace);
    },
    storage,
  } as unknown as PluginBackgroundContext;
  const toolIn = (workspace: PluginWorkspace, caller: ToolCaller = "agent") => ({ workspace, storage, caller }) as unknown as CanvasToolContext;
  return { kept, storage, redraws, told, tabOf, background, toolIn };
}

let mirador: ReturnType<typeof fakeMirador>;
const run = (tool: string, input: unknown, context: CanvasToolContext) => host.tools[tool]!.run(input, context) as string;
const act = (action: TabAction, workspace = kernel) => host.workspaceTab!.action!(action, mirador.tabOf(workspace));
const todos = () => todosIn(mirador.storage);

beforeEach(() => {
  setSystemTime(NOW);
  mirador = fakeMirador();
  watchWorkspaces(mirador.background);
});
afterEach(() => {
  setSystemTime();
  watchWorkspaces(null);
});

describe("todo_add", () => {
  test("adds to the conversation's workspace, with the due time the agent gave, and redraws that workspace's tab", () => {
    const said = run("todo_add", { text: "send the summary", due: "2026-11-27T14:00:00+01:00", note: "CB-123" }, mirador.toolIn(kernel));
    expect(todos()).toEqual([
      expect.objectContaining({ workspaceId: "w-kernel", workspaceName: "kernel", text: "send the summary", note: "CB-123", dueAt: Date.parse("2026-11-27T13:00:00Z"), doneAt: null }),
    ]);
    expect(said).toContain("Added to the To-do tab of kernel");
    expect(said).toContain("send the summary");
    expect(mirador.redraws.get("w-kernel")).toBe(1);
    expect(mirador.redraws.get("w-site")).toBeUndefined();
  });

  test("the agent's text stays as written; only the user's slash command reads a time out of it", () => {
    run("todo_add", { text: "call the bank tomorrow" }, mirador.toolIn(kernel));
    run("todo_add", { text: "call the bank tomorrow" }, mirador.toolIn(kernel, "user"));
    expect(todos().map(({ text, dueAt }) => ({ text, dueAt }))).toEqual([
      { text: "call the bank tomorrow", dueAt: null },
      { text: "call the bank", dueAt: at(27, 9) },
    ]);
  });

  test("refuses a due time it can't read, saying what would work", () => {
    expect(() => run("todo_add", { text: "lunch", due: "after lunch" }, mirador.toolIn(kernel))).toThrow(/ISO 8601/);
    expect(todos()).toEqual([]);
  });
});

describe("todo_list", () => {
  beforeEach(() => {
    run("todo_add", { text: "later one", due: "mon 9:00" }, mirador.toolIn(kernel));
    run("todo_add", { text: "no time" }, mirador.toolIn(kernel));
    run("todo_add", { text: "overdue one", due: "2026-11-25T16:00:00+01:00" }, mirador.toolIn(kernel));
    run("todo_add", { text: "site copy", due: "fri 14:00" }, mirador.toolIn(website));
  });

  test("lists this workspace's open to-dos, the soonest due first and those with no time last", () => {
    const said = run("todo_list", {}, mirador.toolIn(kernel));
    const order = ["overdue one", "later one", "no time"].map((text) => said.indexOf(text));
    expect(order).toEqual([...order].sort((one, other) => one - other));
    expect(said).toContain("Open to-dos in kernel, the soonest due first (3)");
    expect(said).toContain("overdue, ");
    expect(said).not.toContain("site copy");
  });

  test("lists every workspace's, each named, for a morning overview", () => {
    const said = run("todo_list", { all_workspaces: true }, mirador.toolIn(kernel));
    expect(said).toContain("Open to-dos in every workspace, the soonest due first (4)");
    expect(said).toContain("[website]: site copy");
    expect(said).toContain("[kernel]: no time");
  });

  test("names a workspace as Mirador has it now, after a rename", () => {
    mirador.background.workspaces = () => [{ ...website, name: "marketing site" }, kernel];
    expect(run("todo_list", { all_workspaces: true }, mirador.toolIn(kernel))).toContain("[marketing site]: site copy");
  });

  test("adds the ones done in the last 7 days when asked", () => {
    const [first] = todos();
    run("todo_update", { id: first!.id, done: true }, mirador.toolIn(kernel));
    expect(run("todo_list", {}, mirador.toolIn(kernel))).not.toContain("later one");
    expect(run("todo_list", { include_done: true }, mirador.toolIn(kernel))).toContain("Done in the last 7 days (1):\n- ");
  });

  test("says so when there's nothing open", () => {
    expect(run("todo_list", {}, mirador.toolIn({ id: "w-empty", name: "empty", folder: "/e" }))).toBe("No open to-dos in empty.");
  });
});

describe("todo_update", () => {
  let todo: Todo;
  beforeEach(() => {
    run("todo_add", { text: "write notes", due: "fri 14:00", note: "for the demo" }, mirador.toolIn(kernel));
    todo = todos()[0]!;
    mirador.redraws.clear();
  });

  test("ticks one off and opens it again", () => {
    run("todo_update", { id: todo.id, done: true }, mirador.toolIn(kernel));
    expect(todos()[0]!.doneAt).toBe(NOW.getTime());
    run("todo_update", { id: todo.id, done: false }, mirador.toolIn(kernel));
    expect(todos()[0]!.doneAt).toBeNull();
    expect(mirador.redraws.get("w-kernel")).toBe(2);
  });

  test("rewords and reschedules it, and takes its time or note off with null", () => {
    run("todo_update", { id: todo.id, text: "write the demo notes", due: "mon 9:00" }, mirador.toolIn(kernel));
    expect(todos()[0]).toEqual(expect.objectContaining({ text: "write the demo notes", dueAt: at(30, 9), note: "for the demo" }));
    run("todo_update", { id: todo.id, due: null, note: null }, mirador.toolIn(kernel));
    expect(todos()[0]).toEqual(expect.objectContaining({ dueAt: null, note: null }));
  });

  test("a conversation in another workspace can change it, and that workspace's tab redraws", () => {
    run("todo_update", { id: todo.id, done: true }, mirador.toolIn(website));
    expect(mirador.redraws.get("w-kernel")).toBe(1);
  });

  test("deletes it", () => {
    expect(run("todo_update", { id: todo.id, delete: true }, mirador.toolIn(kernel))).toBe("Deleted: write notes");
    expect(todos()).toEqual([]);
  });

  test("says how to find the id again for one that's gone", () => {
    expect(() => run("todo_update", { id: "nope", done: true }, mirador.toolIn(kernel))).toThrow(/List them again/);
  });
});

describe("the To-do tab", () => {
  test("reads a typed line for its preview without changing anything", () => {
    expect(act({ kind: "read", line: "send the summary fri 14:00" })).toEqual({ text: "send the summary", dueAt: at(27, 14) });
    expect(todos()).toEqual([]);
    expect(mirador.redraws.size).toBe(0);
  });

  test("adds a line with the time its words name, a picked time, or none when the user kept the words", () => {
    act({ kind: "add", line: "send the summary fri 14:00", dueAt: null, readsTime: true });
    act({ kind: "add", line: "release party", dueAt: at(28, 18), readsTime: true });
    act({ kind: "add", line: "read chapter fri", dueAt: null, readsTime: false });
    expect(todos().map(({ text, dueAt }) => ({ text, dueAt }))).toEqual([
      { text: "send the summary", dueAt: at(27, 14) },
      { text: "release party", dueAt: at(28, 18) },
      { text: "read chapter fri", dueAt: null },
    ]);
    expect(mirador.redraws.get("w-kernel")).toBe(3);
  });

  test("shows only its own workspace's, open ones soonest first and done ones latest first", () => {
    act({ kind: "add", line: "second fri", dueAt: null, readsTime: true });
    const first = act({ kind: "add", line: "first", dueAt: at(26, 12), readsTime: true }) as Todo;
    act({ kind: "add", line: "elsewhere", dueAt: null, readsTime: true }, website);
    const done = act({ kind: "add", line: "done one", dueAt: null, readsTime: true }) as Todo;
    act({ kind: "done", id: done.id, done: true });
    const state = tabState(mirador.tabOf(kernel));
    expect(state.workspace).toBe("kernel");
    expect(state.open.map(({ text }) => text)).toEqual(["first", "second"]);
    expect(state.done.map(({ text }) => text)).toEqual(["done one"]);
    expect(state.open[0]!.id).toBe(first.id);
  });

  test("edits a to-do's text, note and time", () => {
    const todo = act({ kind: "add", line: "draft", dueAt: null, readsTime: true }) as Todo;
    act({ kind: "change", id: todo.id, text: "draft the plan", note: "see the doc", dueAt: at(27, 10) });
    expect(todos()[0]).toEqual(expect.objectContaining({ text: "draft the plan", note: "see the doc", dueAt: at(27, 10) }));
  });

  test("refuses an empty to-do", () => {
    expect(() => act({ kind: "add", line: "   ", dueAt: null, readsTime: true })).toThrow("Write what there is to do.");
  });

  test("a deleted to-do comes back with Undo", () => {
    const todo = act({ kind: "add", line: "keep me fri", dueAt: null, readsTime: true }) as Todo;
    const deleted = act({ kind: "delete", id: todo.id }) as Todo;
    expect(todos()).toEqual([]);
    act({ kind: "restore", todo: deleted });
    expect(todos()).toEqual([todo]);
  });
});

test("done to-dos are dropped once they're 30 days old, open ones never", () => {
  const old = act({ kind: "add", line: "old done", dueAt: null, readsTime: false }) as Todo;
  act({ kind: "add", line: "old open", dueAt: null, readsTime: false });
  act({ kind: "done", id: old.id, done: true });
  setSystemTime(new Date(NOW.getTime() + DONE_KEPT_MS + 1000));
  act({ kind: "add", line: "new", dueAt: null, readsTime: false });
  expect(todos().map(({ text }) => text)).toEqual(["old open", "new"]);
});

test("the tools load on request, so they cost a conversation nothing until it needs them", () => {
  expect(host.guidance?.summary).toBeTruthy();
  expect(Object.keys(host.tools)).toEqual(["todo_add", "todo_list", "todo_update"]);
  expect(host.tools.todo_add!.command).toBeDefined();
});

describe("ringing", () => {
  const ringAt = (time: number) => {
    setSystemTime(new Date(time));
    return ringDue(mirador.background);
  };
  const addAt = (line: string, dueAt: number, workspace = kernel) => act({ kind: "add", line, dueAt, readsTime: false }, workspace) as Todo;

  test("a to-do rings once as it comes due, in its own words, through its workspace, and the ringer wakes for it", () => {
    run("todo_add", { text: "send the summary", due: "2026-11-26T11:00:00", note: "CB-123" }, mirador.toolIn(kernel));
    expect(ringAt(at(26, 10, 59, 50))).toBe(10_000);
    expect(mirador.told).toEqual([]);
    ringAt(at(26, 11));
    expect(mirador.told).toEqual([{ workspace: "kernel", title: "send the summary", body: "Due today 11:00 · CB-123" }]);
    expect(ringAt(at(26, 11, 5))).toBe(LOOK_AGAIN_MS);
    expect(mirador.told).toHaveLength(1);
  });

  test("those that come due together ring as one notification for each workspace", () => {
    addAt("review the patch", at(26, 12));
    addAt("answer Anna", at(26, 12));
    addAt("publish the page", at(26, 12), website);
    ringAt(at(26, 12, 1));
    expect(mirador.told).toEqual([
      { workspace: "kernel", title: "2 to-dos are due", body: "review the patch · answer Anna" },
      { workspace: "website", title: "publish the page", body: "Due today 12:00" },
    ]);
  });

  test("done ones, ones with no time, and those of a workspace Mirador has closed don't ring", () => {
    const done = addAt("done already", at(26, 12));
    act({ kind: "done", id: done.id, done: true });
    act({ kind: "add", line: "some day", dueAt: null, readsTime: false });
    saveTodos(mirador.storage, [...todos(), { ...done, id: "elsewhere", workspaceId: "w-closed", workspaceName: "old", doneAt: null }]);
    ringAt(at(26, 13));
    expect(mirador.told).toEqual([]);
  });

  test("a to-do that came due while Mirador was off rings once as it starts", () => {
    saveTodos(mirador.storage, [{ ...newTodo(kernel, { text: "call the bank" }, at(25, 9)), dueAt: at(25, 18) }]);
    watchWorkspaces(mirador.background);
    watchWorkspaces(mirador.background);
    expect(mirador.told).toEqual([{ workspace: "kernel", title: "call the bank", body: "Due yesterday 18:00" }]);
  });

  test("a to-do given a new time rings again then, and a time already past as it's given doesn't ring", () => {
    const todo = addAt("deploy", at(26, 11));
    ringAt(at(26, 11));
    act({ kind: "change", id: todo.id, dueAt: at(26, 15) });
    ringAt(at(26, 15));
    act({ kind: "change", id: todo.id, dueAt: at(26, 14) });
    addAt("already late", at(26, 9));
    ringAt(at(26, 15, 30));
    expect(mirador.told.map(({ title, body }) => `${title}: ${body}`)).toEqual(["deploy: Due today 11:00", "deploy: Due today 15:00"]);
  });

  test("a to-do Mirador couldn't tell of stays due, and rings at the next look", () => {
    const failed = spyOn(console, "error").mockImplementation(() => undefined);
    addAt("deploy", at(26, 11));
    const refusing = { ...mirador.background, inWorkspace: () => ({ notify: () => { throw new Error("Mirador can't notify yet."); } }) } as unknown as PluginBackgroundContext;
    setSystemTime(new Date(at(26, 11)));
    ringDue(refusing);
    expect(failed).toHaveBeenCalledTimes(1);
    failed.mockRestore();
    ringAt(at(26, 11, 1));
    expect(mirador.told.map(({ title }) => title)).toEqual(["deploy"]);
  });
});
