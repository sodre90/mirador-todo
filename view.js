/**
 * To-do, drawn in a workspace's tab: a line to add one, its time in plain words or picked from quick picks and a
 * calendar; the open ones in groups by when they're due, and the latest done ones. Mirador posts the workspace's state;
 * every change goes back to the plugin's host code with `mirador.send`. An open editor and the line being typed outlive
 * every drawing of the page.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CALENDAR_WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const GROUPS = [
  { urgency: "overdue", heading: "Overdue" },
  { urgency: "today", heading: "Today" },
  { urgency: "later", heading: "Coming up" },
  { urgency: "none", heading: "No time" },
];
/** Times of day the calendar offers beside the user's morning. */
const TIMES_OF_DAY = [12 * 60, 14 * 60, 17 * 60, 18 * 60];
const QUICK_NAMES = { "in 3h": "In 3 hours" };
const READ_AFTER_MS = 120;
const UNDO_SHOWN_MS = 6000;

let state = { workspace: "", open: [], done: [] };
/** The quick picks for a due time and the user's morning, as the host last read them. */
let picks = { quick: [], morning: 9 * 60 };
/** The to-do being edited, the editor's own node and its picker, kept until it closes so a redraw doesn't lose what's typed. */
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
const clockOfMinutes = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const startOfDay = (time) => new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();
const minutesOf = (time) => new Date(time).getHours() * 60 + new Date(time).getMinutes();
const atMinutes = (day, minutes) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60).getTime();
const daysAfter = (day, days) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
const dayName = (day) => `${WEEKDAYS[day.getDay()]} ${day.getDate()} ${MONTHS[day.getMonth()]} ${day.getFullYear()}`;

function dayWords(dueAt, now = new Date()) {
  const due = new Date(dueAt);
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS);
  return days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : `${WEEKDAYS[due.getDay()]} ${due.getDate()} ${MONTHS[due.getMonth()]}`;
}

const dueWords = (dueAt, now = new Date()) => `${dayWords(dueAt, now)} ${clockOf(new Date(dueAt))}`;

/** How far off a time is, roughly: "in 25 min", "in 3h", "2d ago". */
function fromNow(dueAt, now = Date.now()) {
  const minutes = Math.round((dueAt - now) / MINUTE_MS);
  const size = Math.abs(minutes);
  const amount = size < 60 ? `${Math.max(size, 1)} min` : size < 24 * 60 ? `${Math.round(size / 60)}h` : `${Math.round(size / (24 * 60))}d`;
  return minutes >= 0 ? `in ${amount}` : `${amount} ago`;
}

function urgencyOf(todo, now = new Date()) {
  if (todo.dueAt === null) return "none";
  if (todo.dueAt <= now.getTime()) return "overdue";
  return startOfDay(new Date(todo.dueAt)) === startOfDay(now) ? "today" : "later";
}

/**
 * A due time picked from quick picks, or from a calendar with times of day. The calendar opens inside the card it's in,
 * where the tab's frame can't cut it off. `changed` hears every pick, null for no time; `toggled`, the calendar opening
 * and closing.
 */
function duePicker({ dueAt = null, offersNoTime = false, changed, toggled = () => undefined }) {
  let value = dueAt;
  let calendarOpen = false;
  let shown = new Date(value ?? Date.now());
  /** The day the arrow keys moved to, focused again after the calendar redraws. */
  let focusedDay = null;
  const node = el("div", { class: "picker", role: "group", "aria-label": "Due" });

  const pick = (next) => {
    value = next;
    if (value !== null) shown = new Date(value);
    draw();
    changed(value);
  };
  const pickDay = (day) => {
    focusedDay = day;
    pick(atMinutes(day, value === null ? picks.morning : minutesOf(value)));
  };
  const pickTime = (minutes) => {
    const today = new Date();
    const day = value !== null ? new Date(value) : atMinutes(today, minutes) > Date.now() ? today : daysAfter(today, 1);
    pick(atMinutes(day, minutes));
  };
  const showCalendar = (open) => {
    calendarOpen = open;
    focusedDay = null;
    draw();
    toggled();
  };
  const toggleCalendar = () => {
    if (!calendarOpen) readPicks();
    showCalendar(!calendarOpen);
  };

  const quickRow = () =>
    el(
      "div",
      { class: "quick" },
      picks.quick.map(({ words, dueAt: at }) =>
        el(
          "button",
          { class: "chip", type: "button", "aria-pressed": String(value === at), onclick: () => ((focusedDay = null), pick(at)) },
          QUICK_NAMES[words] ?? dayWords(at),
          " ",
          el("small", { text: clockOf(new Date(at)) }),
        ),
      ),
      el("button", { class: "chip", type: "button", "aria-expanded": String(calendarOpen), text: "Pick a day…", onclick: toggleCalendar }),
      offersNoTime ? el("button", { class: "chip", type: "button", "aria-pressed": String(value === null), text: "No time", onclick: () => pick(null) }) : null,
    );

  function moveFocus(event, day) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!step) return;
    event.preventDefault();
    focusedDay = daysAfter(day, step);
    shown = focusedDay;
    draw();
  }

  function calendar() {
    const today = startOfDay(new Date());
    const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7;
    const inMonth = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
    const cells = lead + inMonth <= 35 ? 35 : 42;
    const days = Array.from({ length: cells }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - lead + index));
    const pickedDay = value === null ? null : startOfDay(new Date(value));
    const tabbable = startOfDay(focusedDay ?? (pickedDay !== null && new Date(pickedDay).getMonth() === shown.getMonth() ? new Date(pickedDay) : first));
    const showMonth = (months) => {
      shown = new Date(shown.getFullYear(), shown.getMonth() + months, 1);
      focusedDay = null;
      draw();
    };
    const times = [...new Set([picks.morning, ...TIMES_OF_DAY])].sort((a, b) => a - b);
    const otherTime = el("input", {
      class: "other-time",
      type: "time",
      "aria-label": "Other time",
      value: value === null || times.includes(minutesOf(value)) ? "" : clockOf(new Date(value)),
      onchange: (event) => {
        const [hours, minutes] = event.target.value.split(":").map(Number);
        if (Number.isInteger(hours) && Number.isInteger(minutes)) pickTime(hours * 60 + minutes);
      },
    });
    return el(
      "div",
      { class: "calendar" },
      el(
        "div",
        { class: "month-days" },
        el(
          "div",
          { class: "month" },
          el("strong", { text: `${MONTH_NAMES[shown.getMonth()]} ${shown.getFullYear()}` }),
          el("button", { class: "icon", type: "button", "aria-label": "Previous month", text: "‹", onclick: () => showMonth(-1) }),
          el("button", { class: "icon", type: "button", "aria-label": "This month", text: "•", onclick: () => ((shown = new Date()), (focusedDay = null), draw()) }),
          el("button", { class: "icon", type: "button", "aria-label": "Next month", text: "›", onclick: () => showMonth(1) }),
        ),
        el(
          "div",
          { class: "days" },
          CALENDAR_WEEKDAYS.map((name) => el("span", { class: "weekday", text: name, "aria-hidden": "true" })),
          days.map((day) => {
            const time = day.getTime();
            return el("button", {
              class: ["day", day.getMonth() !== shown.getMonth() && "outside", time === today && "today"].filter(Boolean).join(" "),
              type: "button",
              text: String(day.getDate()),
              "aria-label": dayName(day),
              "aria-pressed": String(time === pickedDay),
              "data-day": String(time),
              tabindex: time === tabbable ? "0" : "-1",
              disabled: time < today && time !== pickedDay,
              onclick: () => pickDay(day),
              onkeydown: (event) => moveFocus(event, day),
            });
          }),
        ),
      ),
      el(
        "div",
        { class: "times" },
        el("span", { class: "label", text: "Time" }),
        times.map((minutes) =>
          el("button", { class: "chip", type: "button", text: clockOfMinutes(minutes), "aria-pressed": String(value !== null && minutesOf(value) === minutes), onclick: () => pickTime(minutes) }),
        ),
        otherTime,
      ),
      el(
        "div",
        { class: "picked" },
        value === null
          ? el("span", { class: "muted", text: "Pick a day, then a time." })
          : el("span", {}, "Due ", el("b", { text: dueWords(value) }), el("span", { class: "muted", text: ` · ${fromNow(value)}` })),
        el("button", { class: "btn go small", type: "button", text: "Done", onclick: toggleCalendar }),
      ),
    );
  }

  function draw() {
    node.replaceChildren(quickRow(), ...(calendarOpen ? [calendar()] : []));
    if (focusedDay) node.querySelector(`[data-day="${startOfDay(focusedDay)}"]`)?.focus();
  }

  node.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !calendarOpen) return;
    event.stopPropagation();
    showCalendar(false);
    node.querySelector('[aria-expanded="false"]')?.focus();
  });
  draw();
  return {
    node,
    get value() {
      return value;
    },
    get calendarOpen() {
      return calendarOpen;
    },
    clear() {
      value = null;
      shown = new Date();
      showCalendar(false);
    },
    /** The calendar only when its times moved with the morning, so focus and a time half typed in it stay otherwise. */
    showPicks: ({ morningMoved }) => (morningMoved && calendarOpen ? draw() : node.firstChild?.replaceWith(quickRow())),
  };
}

const page = el("main", { class: "todo" });
const heading = el("h1", { text: "To-do" });
const counts = el("p", { class: "counts" });
const next = el("p", { class: "next" });
const line = el("input", {
  class: "line",
  type: "text",
  "aria-label": "New to-do",
  placeholder: "Add a to-do, e.g. “send the summary fri 14:00”",
  autocomplete: "off",
  spellcheck: "true",
});
const addButton = el("button", { class: "btn go", type: "button", text: "Add" });
const composerPicker = duePicker({ changed: () => drawPreview(), toggled: () => drawPreview() });
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
  el("header", {}, heading, counts, next),
  el("div", { class: "composer" }, el("div", { class: "composer-line" }, line, addButton), composerPicker.node, preview),
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
  notice.hidden = text === "";
  if (!undo) return;
  notice.append(" ", el("button", { class: "link", type: "button", text: "Undo", onclick: () => (say(""), undo()) }));
  undoTimer = setTimeout(() => say(""), UNDO_SHOWN_MS);
};

const send = (action) =>
  window.mirador.send(action).catch((error) => {
    say(error.message, { failed: true });
    throw error;
  });

const dueChip = (dueAt) => [el("span", { class: "due-chip", text: `Due ${dueWords(dueAt)}` }), el("span", { class: "muted", text: ` · ${fromNow(dueAt)}` })];

function showPreview(...children) {
  preview.replaceChildren(...children);
  preview.hidden = children.length === 0;
}

function drawPreview() {
  const pickedAt = composerPicker.value;
  if (pickedAt !== null && composerPicker.calendarOpen) {
    showPreview();
    return;
  }
  if (pickedAt !== null) {
    showPreview(...dueChip(pickedAt), " ", el("button", { class: "link", type: "button", text: "Clear", onclick: () => (composerPicker.clear(), drawPreview()) }));
    return;
  }
  if (reading.line !== line.value.trim() || reading.dueAt === null) {
    showPreview();
    return;
  }
  if (keepsWords) {
    showPreview(
      el("span", { class: "muted", text: "No time; the words stay as typed." }),
      " ",
      el("button", { class: "link", type: "button", text: "Read the time", onclick: () => ((keepsWords = false), drawPreview()) }),
    );
    return;
  }
  showPreview(
    ...dueChip(reading.dueAt),
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

function clearComposer() {
  line.value = "";
  composerPicker.clear();
  readLine();
}

async function add() {
  const typed = line.value.trim();
  if (typed === "") {
    line.focus();
    return;
  }
  const pickedAt = composerPicker.value;
  const added = await send({ kind: "add", line: typed, dueAt: pickedAt, readsTime: pickedAt === null && !keepsWords }).catch(() => null);
  if (!added) return;
  clearComposer();
  say(added.dueAt === null ? `Added “${added.text}”.` : `Added “${added.text}”, due ${dueWords(added.dueAt).toLowerCase()}.`);
  line.focus();
}

line.addEventListener("input", readLine);
line.addEventListener("focus", readPicks);
line.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    void add();
  }
  if (event.key === "Escape") clearComposer();
});
addButton.addEventListener("click", () => void add());

async function tick(todo, done) {
  await send({ kind: "done", id: todo.id, done }).catch(() => null);
  if (done) say(`Done: “${todo.text}”.`, { undo: () => void send({ kind: "done", id: todo.id, done: false }) });
}

async function remove(todo) {
  const deleted = await send({ kind: "delete", id: todo.id }).catch(() => null);
  if (deleted) say(`Deleted “${todo.text}”.`, { undo: () => void send({ kind: "restore", todo: deleted }) });
}

const field = (label, ...children) => el("div", { class: "field" }, el("span", { class: "label", text: label }), ...children);

function openEditor(todo) {
  const text = el("input", { name: "text", type: "text", value: todo.text, "aria-label": "To-do" });
  const picker = duePicker({ dueAt: todo.dueAt, offersNoTime: true, changed: () => undefined });
  const note = el("textarea", { name: "note", rows: "2", "aria-label": "Note", placeholder: "A note, such as a link to its ticket" });
  note.value = todo.note ?? "";
  const close = () => {
    editing = null;
    draw();
  };
  const save = async () => {
    const saved = await send({ kind: "change", id: todo.id, text: text.value, note: note.value, dueAt: picker.value }).catch(() => null);
    if (saved) close();
  };
  const node = el(
    "li",
    { class: "editor" },
    field("To-do", text),
    field("When", picker.node),
    field("Note", note),
    el(
      "div",
      { class: "editor-foot" },
      el("span", { class: "keys", text: "↩ saves · Esc cancels" }),
      el("button", { class: "btn", type: "button", text: "Cancel", onclick: close }),
      el("button", { class: "btn go", type: "button", text: "Save", onclick: () => void save() }),
    ),
  );
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    const saves = event.key === "Enter" && !event.isComposing && (event.target === text || event.metaKey || event.ctrlKey);
    if (saves) void save();
  });
  editing = { id: todo.id, node, picker };
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
    todo.dueAt === null ? null : el("span", { class: `due ${done ? "" : urgency}`, text: dueWords(todo.dueAt, now), title: fromNow(todo.dueAt, now.getTime()) }),
    el(
      "div",
      { class: "row-buttons" },
      done ? null : el("button", { class: "btn quiet", type: "button", text: "Edit", "aria-label": `Edit ${todo.text}`, onclick: () => openEditor(todo) }),
      el("button", { class: "btn quiet", type: "button", text: "Delete", "aria-label": `Delete ${todo.text}`, onclick: () => void remove(todo) }),
    ),
  );
}

function drawHeader(now) {
  const overdue = state.open.filter((todo) => urgencyOf(todo, now) === "overdue").length;
  counts.replaceChildren(
    state.open.length === 0 ? "" : `${state.open.length} open`,
    overdue === 0 ? "" : el("span", { class: "overdue", text: ` · ${overdue} overdue` }),
  );
  const soonest = state.open.filter(({ dueAt }) => dueAt !== null && dueAt > now.getTime()).sort((a, b) => a.dueAt - b.dueAt)[0];
  next.hidden = !soonest;
  if (soonest) next.replaceChildren(el("span", { class: "dot", "aria-hidden": "true" }), "Next · ", el("b", { text: soonest.text }), ` ${fromNow(soonest.dueAt, now.getTime())}`);
}

function draw() {
  const now = new Date();
  drawHeader(now);
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

/**
 * The quick picks move with the clock, and with the user's morning, which Mirador doesn't tell the tab of when it
 * changes: so they're read again as the user comes back to the tab, or to the line or a calendar in it. Not on every
 * state Mirador sends, which only the to-dos change.
 */
function readPicks() {
  window.mirador.send({ kind: "picks" }).then(
    (read) => {
      const morningMoved = read.morning !== picks.morning;
      picks = read;
      composerPicker.showPicks({ morningMoved });
      editing?.picker.showPicks({ morningMoved });
    },
    () => undefined,
  );
}

function matchColorScheme() {
  const background = getComputedStyle(document.documentElement).getPropertyValue("--mirador-bg").match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!background) return;
  const dark = (Number(background[1]) + Number(background[2]) + Number(background[3])) / 3 < 128;
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

let picksRead = false;
window.mirador.onState((shown) => {
  state = shown ?? { workspace: "", open: [], done: [] };
  if (editing && !state.open.some(({ id }) => id === editing.id)) editing = null;
  matchColorScheme();
  draw();
  if (!picksRead) readPicks();
  picksRead = true;
});
window.addEventListener("focus", readPicks);
/** Once a minute, so what's due today or overdue moves to its group, and the quick picks move on, as the clock passes. */
setInterval(() => {
  draw();
  drawPreview();
  readPicks();
}, 60_000);
say("");
drawPreview();

const style = document.createElement("style");
style.textContent = `
:root {
  --bg: var(--mirador-bg, #fff); --panel: var(--mirador-panel, #fff); --panel-2: var(--mirador-panel-2, #f6f6f8);
  --border: var(--mirador-border, #e7e7eb); --text: var(--mirador-text, #1a1b20); --muted: var(--mirador-muted, #62656e);
  --faint: var(--mirador-faint, #9a9ca4); --accent: var(--mirador-accent, #5b5bd6); --accent-text: var(--mirador-accent-text, #fff);
  --accent-soft: var(--mirador-accent-soft, #efeffc); --ok: var(--mirador-ok, #2e9e6b); --danger: var(--mirador-danger, #d93d42);
  --danger-soft: color-mix(in srgb, var(--danger) 12%, var(--bg));
  font-size: calc(13px * var(--mirador-font-scale, 1));
}
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--panel); }
body { margin: 0; background: var(--panel); color: var(--text); font: 1rem/1.45 var(--mirador-font, system-ui, sans-serif); -webkit-font-smoothing: antialiased; }
button, input, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }

.todo { padding: 1.1rem 1.25rem 2.4rem; max-width: 46rem; }
header { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
h1 { font-size: 1.35rem; margin: 0; letter-spacing: -.015em; }
.counts { margin: 0; color: var(--muted); }
.counts .overdue { color: var(--danger); font-weight: 600; }
.next { margin: 0 0 0 auto; display: inline-flex; align-items: center; gap: .35rem; max-width: 100%; padding: .12rem .65rem; border-radius: 99px; background: var(--accent-soft); color: var(--accent); font-size: .9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.next b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.dot { width: .45rem; height: .45rem; border-radius: 50%; background: var(--accent); flex: none; }

.composer { margin-top: .9rem; padding: .55rem .6rem .6rem; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); transition: border-color .15s, box-shadow .15s; }
.composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.composer-line { display: flex; gap: .45rem; align-items: center; }
.composer .line { flex: 1; min-width: 0; border: 0; padding: .3rem .2rem; background: transparent; box-shadow: none; }
.composer .line:focus { box-shadow: none; }
input, textarea { padding: .45rem .6rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); transition: border-color .15s, box-shadow .15s; }
input:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
textarea { resize: vertical; width: 100%; }
.preview { margin: .5rem .2rem 0; font-size: .92rem; }
.due-chip { display: inline-block; padding: 0 .5rem; border-radius: 99px; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.muted { color: var(--muted); }
.notice { margin: .55rem 0 0; font-size: .92rem; color: var(--muted); }
.notice.failed { color: var(--danger); }

.btn { display: inline-flex; align-items: center; padding: .38rem .8rem; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); white-space: nowrap; cursor: pointer; transition: background .15s, border-color .15s, opacity .15s; }
.btn:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.btn.go { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.btn.small { padding: .18rem .7rem; }
.btn.quiet { padding: .15rem .55rem; font-size: .88rem; }
.link { border: 0; padding: 0; background: none; color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }

.picker { display: grid; gap: .55rem; container-type: inline-size; }
.composer .picker { margin-top: .45rem; }
.quick, .times { display: flex; gap: .3rem; flex-wrap: wrap; align-items: center; }
.chip { padding: .12rem .65rem; border: 1px solid var(--border); border-radius: 99px; background: var(--panel-2); font-size: .9rem; cursor: pointer; transition: background .15s, border-color .15s, color .15s; }
.chip:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.chip small { color: var(--muted); font-size: .85em; }
.chip[aria-pressed="true"], .chip[aria-expanded="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.chip[aria-pressed="true"] small { color: inherit; opacity: .85; }
.calendar { display: grid; grid-template-columns: minmax(0, 20rem); gap: .6rem 1rem; width: fit-content; max-width: 100%; padding: .7rem; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); }
.month-days { display: grid; gap: .45rem; }
.month { display: flex; align-items: center; gap: .15rem; }
.month strong { margin-right: auto; font-size: 1rem; }
.icon { width: 1.8rem; height: 1.8rem; border: 0; border-radius: 8px; background: none; color: var(--muted); font-size: 1.1rem; line-height: 1; cursor: pointer; }
.icon:hover { background: var(--panel-2); color: var(--text); }
.days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center; }
.weekday { padding-bottom: .2rem; color: var(--muted); font-size: .78rem; }
.day { aspect-ratio: 1; min-height: 1.9rem; border: 0; border-radius: 8px; background: none; font-variant-numeric: tabular-nums; cursor: pointer; }
.day:hover:not(:disabled) { background: var(--panel-2); }
.day.outside { color: var(--faint); }
.day.today { color: var(--accent); font-weight: 600; box-shadow: inset 0 0 0 1.5px var(--accent); }
.day[aria-pressed="true"] { background: var(--accent); color: var(--accent-text); font-weight: 600; box-shadow: none; }
.day:disabled { color: var(--faint); opacity: .45; cursor: default; }
.label { font-size: .72rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.times .label { margin-right: .2rem; }
.other-time { padding: .1rem .4rem; border-radius: 99px; font-size: .9rem; }
@container (min-width: 29rem) {
  .calendar { grid-template-columns: 17rem auto; }
  .times { flex-direction: column; flex-wrap: nowrap; align-items: stretch; padding-left: 1rem; border-left: 1px solid var(--border); }
  .times .label { margin: .35rem 0 .15rem; }
  .times .chip { text-align: center; font-variant-numeric: tabular-nums; }
  .picked { grid-column: 1 / -1; }
}
.picked { display: flex; align-items: center; gap: .5rem; padding-top: .55rem; border-top: 1px solid var(--border); font-size: .92rem; }
.picked b { color: var(--accent); }
.picked .btn { margin-left: auto; }

.empty { margin-top: 1.2rem; padding: 1.4rem; border: 1px dashed var(--border); border-radius: 12px; text-align: center; }
.empty p { margin: 0; }
.empty .hint { margin-top: .35rem; color: var(--muted); font-size: .92rem; }

.group { margin-top: 1.1rem; }
h2, summary { font-size: .75rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 0 0 .4rem; }
.group.overdue h2 { color: var(--danger); }
.group.today h2 { color: var(--accent); }
ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); overflow: hidden; }
li + li { border-top: 1px solid var(--border); }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: .7rem; align-items: center; padding: .55rem .75rem; transition: background .15s; }
.row:hover { background: color-mix(in srgb, var(--panel-2) 60%, transparent); }
.row input[type="checkbox"] { appearance: none; display: grid; place-content: center; width: 1.15rem; height: 1.15rem; margin: 0; padding: 0; border: 1.5px solid var(--faint); border-radius: 50%; background: var(--bg); cursor: pointer; transition: border-color .15s, background .15s; }
.row input[type="checkbox"]:hover { border-color: var(--ok); }
.row input[type="checkbox"]:checked { border-color: var(--ok); background: var(--ok); }
.row input[type="checkbox"]:checked::after { content: ""; width: .3rem; height: .58rem; border: solid #fff; border-width: 0 2px 2px 0; transform: translateY(-1px) rotate(45deg); }
.row.overdue input[type="checkbox"] { border-color: color-mix(in srgb, var(--danger) 60%, var(--faint)); }
.body { display: grid; min-width: 0; }
.text { overflow-wrap: anywhere; }
.note { color: var(--muted); font-size: .88rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.due { padding: .05rem .55rem; border-radius: 99px; font-size: .86rem; font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
.due.overdue { background: var(--danger-soft); color: var(--danger); font-weight: 600; }
.due.today { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.row-buttons { display: flex; gap: .3rem; opacity: 0; transition: opacity .15s; }
.row:hover .row-buttons, .row:focus-within .row-buttons { opacity: 1; }
@media (hover: none) { .row-buttons { opacity: 1; } }
.is-done .text { color: var(--muted); text-decoration: line-through; }

.done { margin-top: 1.2rem; }
summary { cursor: pointer; }
.done[open] summary { margin-bottom: .4rem; }

.editor { display: grid; gap: .7rem; padding: .8rem .85rem; background: var(--panel-2); }
.editor .calendar { background: var(--bg); }
.field { display: grid; gap: .3rem; }
.editor-foot { display: flex; align-items: center; gap: .5rem; }
.keys { margin-right: auto; color: var(--faint); font-size: .82rem; }
`;
document.head.append(style);
