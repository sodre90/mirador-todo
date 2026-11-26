/**
 * To-do, drawn in a workspace's tab: a line to add one with its time in plain words, the open ones in groups by when
 * they're due, and the latest done ones. Mirador posts the workspace's state; every change goes back to the plugin's host
 * code with `mirador.send`. An open editor and the line being typed outlive every drawing of the page.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;
const GROUPS = [
  { urgency: "overdue", heading: "Overdue" },
  { urgency: "today", heading: "Today" },
  { urgency: "later", heading: "Coming up" },
  { urgency: "none", heading: "No time" },
];
const READ_AFTER_MS = 120;
const UNDO_SHOWN_MS = 6000;

let state = { workspace: "", open: [], done: [] };
/** The to-do being edited and the editor's own node, kept until it closes so a redraw doesn't lose what's typed. */
let editing = null;
/** What the typed line reads as: its text and due time, as the host last read it. */
let reading = { line: "", text: "", dueAt: null };
/** The user chose to keep the words of the line as they are, rather than read a time out of them. */
let keepsWords = false;
let readTimer = null;
let undoTimer = null;

const el = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value == null) continue;
    if (name === "class") node.className = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (name === "text") node.textContent = value;
    else if (name === "value") node.value = value;
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
};

const pad = (number) => String(number).padStart(2, "0");
const clockOf = (time) => `${pad(time.getHours())}:${pad(time.getMinutes())}`;
const startOfDay = (time) => new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();

function dueWords(dueAt, now = new Date()) {
  const due = new Date(dueAt);
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS);
  const day = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : `${WEEKDAYS[due.getDay()]} ${due.getDate()} ${MONTHS[due.getMonth()]}`;
  return `${day} ${clockOf(due)}`;
}

function urgencyOf(todo, now = new Date()) {
  if (todo.dueAt === null) return "none";
  if (todo.dueAt <= now.getTime()) return "overdue";
  return startOfDay(new Date(todo.dueAt)) === startOfDay(now) ? "today" : "later";
}

/** A time as a datetime-local field takes it, on the Mac's own clock. */
const fieldTime = (time) => {
  const at = new Date(time);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${clockOf(at)}`;
};
const timeOfField = (value) => (value ? new Date(value).getTime() : null);

const page = el("main", { class: "todo" });
const heading = el("h1", { text: "To-do" });
const counts = el("p", { class: "counts" });
const line = el("input", {
  class: "line",
  type: "text",
  "aria-label": "New to-do",
  placeholder: "Add a to-do, e.g. “send the summary fri 14:00”",
  autocomplete: "off",
  spellcheck: "true",
});
const picked = el("input", { class: "picked", type: "datetime-local", "aria-label": "Due" });
const addButton = el("button", { class: "btn go", type: "button", text: "Add" });
const preview = el("p", { class: "preview", "aria-live": "polite" });
const notice = el("p", { class: "notice", "aria-live": "polite" });
const groups = el("div", { class: "groups" });
const doneList = el("details", { class: "done" });
const empty = el(
  "div",
  { class: "empty" },
  el("p", { text: "Nothing to do here yet." }),
  el("p", { class: "hint", text: "Add one above, or ask the agent in any conversation, such as “remind me to send the summary on Friday”." }),
);
page.append(
  el("header", {}, heading, counts),
  el("div", { class: "adder" }, line, picked, addButton),
  preview,
  notice,
  empty,
  groups,
  doneList,
);
document.body.append(page);

const say = (text, { failed = false, undo = null } = {}) => {
  clearTimeout(undoTimer);
  notice.replaceChildren(text);
  notice.classList.toggle("failed", failed);
  if (!undo) return;
  notice.append(" ", el("button", { class: "link", type: "button", text: "Undo", onclick: () => (say(""), undo()) }));
  undoTimer = setTimeout(() => say(""), UNDO_SHOWN_MS);
};

const send = (action) =>
  window.mirador.send(action).catch((error) => {
    say(error.message, { failed: true });
    throw error;
  });

function drawPreview() {
  const pickedAt = timeOfField(picked.value);
  if (pickedAt !== null) {
    preview.replaceChildren(el("span", { class: "due-chip", text: `Due ${dueWords(pickedAt)}` }));
    return;
  }
  if (reading.line !== line.value.trim() || reading.dueAt === null) {
    preview.replaceChildren();
    return;
  }
  if (keepsWords) {
    preview.replaceChildren(
      el("span", { class: "muted", text: "No time; the words stay as typed." }),
      " ",
      el("button", { class: "link", type: "button", text: "Read the time", onclick: () => ((keepsWords = false), drawPreview()) }),
    );
    return;
  }
  preview.replaceChildren(
    el("span", { class: "due-chip", text: `Due ${dueWords(reading.dueAt)}` }),
    " ",
    el("span", { class: "muted", text: `“${reading.text}”` }),
    " ",
    el("button", { class: "link", type: "button", text: "Keep the words", onclick: () => ((keepsWords = true), drawPreview()) }),
  );
}

function readLine() {
  clearTimeout(readTimer);
  const typed = line.value.trim();
  if (typed === "") {
    reading = { line: "", text: "", dueAt: null };
    keepsWords = false;
    drawPreview();
    return;
  }
  readTimer = setTimeout(() => {
    window.mirador.send({ kind: "read", line: typed }).then(
      (read) => {
        if (line.value.trim() !== typed) return;
        reading = { line: typed, ...read };
        drawPreview();
      },
      () => undefined,
    );
  }, READ_AFTER_MS);
  drawPreview();
}

async function add() {
  const typed = line.value.trim();
  if (typed === "") {
    line.focus();
    return;
  }
  const pickedAt = timeOfField(picked.value);
  const added = await send({ kind: "add", line: typed, dueAt: pickedAt, readsTime: pickedAt === null && !keepsWords }).catch(() => null);
  if (!added) return;
  line.value = "";
  picked.value = "";
  readLine();
  say(added.dueAt === null ? `Added “${added.text}”.` : `Added “${added.text}”, due ${dueWords(added.dueAt).toLowerCase()}.`);
  line.focus();
}

line.addEventListener("input", readLine);
line.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    void add();
  }
  if (event.key === "Escape") {
    line.value = "";
    picked.value = "";
    readLine();
  }
});
picked.addEventListener("input", drawPreview);
addButton.addEventListener("click", () => void add());

async function tick(todo, done) {
  await send({ kind: "done", id: todo.id, done }).catch(() => null);
  if (done) say(`Done: “${todo.text}”.`, { undo: () => void send({ kind: "done", id: todo.id, done: false }) });
}

async function remove(todo) {
  const deleted = await send({ kind: "delete", id: todo.id }).catch(() => null);
  if (deleted) say(`Deleted “${todo.text}”.`, { undo: () => void send({ kind: "restore", todo: deleted }) });
}

function openEditor(todo) {
  const text = el("input", { name: "text", type: "text", value: todo.text, "aria-label": "To-do" });
  const due = el("input", { name: "due", type: "datetime-local", value: todo.dueAt === null ? "" : fieldTime(todo.dueAt), "aria-label": "Due" });
  const note = el("textarea", { name: "note", rows: "2", "aria-label": "Note", placeholder: "A note, such as a link to its ticket" });
  note.value = todo.note ?? "";
  const close = () => {
    editing = null;
    draw();
  };
  const save = async () => {
    const saved = await send({ kind: "change", id: todo.id, text: text.value, note: note.value, dueAt: timeOfField(due.value) }).catch(() => null);
    if (saved) close();
  };
  const node = el(
    "li",
    { class: "editor" },
    text,
    el("div", { class: "editor-row" }, due, el("button", { class: "link", type: "button", text: "No time", onclick: () => (due.value = "") })),
    note,
    el(
      "div",
      { class: "editor-row end" },
      el("button", { class: "btn", type: "button", text: "Cancel", onclick: close }),
      el("button", { class: "btn go", type: "button", text: "Save", onclick: () => void save() }),
    ),
  );
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter" && event.target === text && !event.isComposing) void save();
  });
  editing = { id: todo.id, node };
  draw();
  text.focus();
}

function row(todo, now) {
  if (editing?.id === todo.id) return editing.node;
  const urgency = urgencyOf(todo, now);
  const done = todo.doneAt !== null;
  return el(
    "li",
    { class: `row ${done ? "is-done" : urgency}`, "data-id": todo.id },
    el("input", { type: "checkbox", checked: done, "aria-label": `Done: ${todo.text}`, onchange: (event) => void tick(todo, event.target.checked) }),
    el(
      "div",
      { class: "body" },
      el("span", { class: "text", text: todo.text }),
      todo.note ? el("span", { class: "note", text: todo.note }) : null,
    ),
    todo.dueAt === null ? null : el("span", { class: `due ${done ? "" : urgency}`, text: dueWords(todo.dueAt, now) }),
    el(
      "div",
      { class: "row-buttons" },
      done ? null : el("button", { class: "btn quiet", type: "button", text: "Edit", "aria-label": `Edit ${todo.text}`, onclick: () => openEditor(todo) }),
      el("button", { class: "btn quiet", type: "button", text: "Delete", "aria-label": `Delete ${todo.text}`, onclick: () => void remove(todo) }),
    ),
  );
}

function draw() {
  const now = new Date();
  const overdue = state.open.filter((todo) => urgencyOf(todo, now) === "overdue").length;
  counts.textContent = [state.open.length === 0 ? "" : `${state.open.length} open`, overdue === 0 ? "" : `${overdue} overdue`].filter(Boolean).join(" · ");
  counts.classList.toggle("has-overdue", overdue > 0);
  empty.hidden = state.open.length > 0 || state.done.length > 0;
  groups.replaceChildren(
    ...GROUPS.map(({ urgency, heading: title }) => {
      const todos = state.open.filter((todo) => urgencyOf(todo, now) === urgency);
      if (todos.length === 0) return null;
      return el("section", { class: `group ${urgency}`, "aria-label": title }, el("h2", { text: `${title} · ${todos.length}` }), el("ul", {}, todos.map((todo) => row(todo, now))));
    }).filter(Boolean),
  );
  const wasOpen = doneList.open;
  doneList.hidden = state.done.length === 0;
  doneList.replaceChildren(el("summary", { text: `Done · ${state.done.length}` }), el("ul", {}, state.done.map((todo) => row(todo, now))));
  doneList.open = wasOpen;
}

function matchColorScheme() {
  const background = getComputedStyle(document.documentElement).getPropertyValue("--mirador-bg").match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!background) return;
  const dark = (Number(background[1]) + Number(background[2]) + Number(background[3])) / 3 < 128;
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

window.mirador.onState((shown) => {
  state = shown ?? { workspace: "", open: [], done: [] };
  if (editing && !state.open.some(({ id }) => id === editing.id)) editing = null;
  matchColorScheme();
  draw();
});
/** Once a minute, so what's due today or overdue moves to its group as the clock passes it. */
setInterval(() => {
  draw();
  drawPreview();
}, 60_000);

const style = document.createElement("style");
style.textContent = `
:root {
  --bg: var(--mirador-bg, #fff); --panel: var(--mirador-panel, #fff); --panel-2: var(--mirador-panel-2, #f6f6f8);
  --border: var(--mirador-border, #e7e7eb); --text: var(--mirador-text, #1a1b20); --muted: var(--mirador-muted, #62656e);
  --faint: var(--mirador-faint, #9a9ca4); --accent: var(--mirador-accent, #5b5bd6); --accent-text: var(--mirador-accent-text, #fff);
  --accent-soft: var(--mirador-accent-soft, #efeffc); --ok: var(--mirador-ok, #2e9e6b); --danger: var(--mirador-danger, #d93d42);
  font-size: calc(13px * var(--mirador-font-scale, 1));
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--panel); color: var(--text); font: 1rem/1.45 var(--mirador-font, system-ui, sans-serif); -webkit-font-smoothing: antialiased; }
button, input, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }

.todo { padding: 1.1rem 1.25rem 2.4rem; max-width: 52rem; }
header { display: flex; align-items: baseline; gap: .7rem; }
h1 { font-size: 1.35rem; margin: 0; letter-spacing: -.015em; }
.counts { margin: 0; color: var(--muted); }
.counts.has-overdue { color: var(--danger); }

.adder { display: flex; gap: .45rem; margin-top: .8rem; }
.adder .line { flex: 1; min-width: 0; }
input, textarea { padding: .45rem .6rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); transition: border-color .15s, box-shadow .15s; }
input:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
textarea { resize: vertical; width: 100%; }
.preview { min-height: 1.5em; margin: .35rem 0 0; font-size: .92rem; }
.due-chip { display: inline-block; padding: 0 .5rem; border-radius: 99px; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.muted { color: var(--muted); }
.notice { min-height: 1.3em; margin: .2rem 0 .4rem; font-size: .92rem; color: var(--muted); }
.notice.failed { color: var(--danger); }

.btn { display: inline-flex; align-items: center; padding: .38rem .8rem; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); white-space: nowrap; cursor: pointer; transition: background .15s, border-color .15s, opacity .15s; }
.btn:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.btn.go { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.btn.quiet { padding: .15rem .55rem; font-size: .88rem; }
.link { border: 0; padding: 0; background: none; color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }

.empty { margin-top: 1.4rem; padding: 1.4rem; border: 1px dashed var(--border); border-radius: 12px; text-align: center; }
.empty p { margin: 0; }
.empty .hint { margin-top: .35rem; color: var(--muted); font-size: .92rem; }

.group { margin-top: 1rem; }
h2, summary { font-size: .82rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--muted); margin: 0 0 .4rem; }
.group.overdue h2 { color: var(--danger); }
.group.today h2 { color: var(--accent); }
ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); overflow: hidden; }
li + li { border-top: 1px solid var(--border); }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: .7rem; align-items: center; padding: .5rem .75rem; }
.row input[type="checkbox"] { width: 1.05rem; height: 1.05rem; margin: 0; accent-color: var(--ok); cursor: pointer; }
.body { display: grid; min-width: 0; }
.text { overflow-wrap: anywhere; }
.note { color: var(--muted); font-size: .88rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.due { font-size: .88rem; font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
.due.overdue { color: var(--danger); font-weight: 600; }
.due.today { color: var(--accent); font-weight: 600; }
.row-buttons { display: flex; gap: .3rem; opacity: 0; transition: opacity .15s; }
.row:hover .row-buttons, .row:focus-within .row-buttons { opacity: 1; }
@media (hover: none) { .row-buttons { opacity: 1; } }
.is-done .text { color: var(--muted); text-decoration: line-through; }

.done { margin-top: 1.2rem; }
summary { cursor: pointer; }
.done[open] summary { margin-bottom: .4rem; }

.editor { display: grid; gap: .5rem; padding: .7rem .75rem; background: var(--panel-2); }
.editor-row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
.editor-row.end { justify-content: flex-end; }
`;
document.head.append(style);
