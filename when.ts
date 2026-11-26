/**
 * A to-do's time, read from its line or its due field. Mirador reads the plain words, as its /remind does, with the
 * user's morning; this file decides where in a line they are, and what else a due field may be.
 */
import type { ReadsTimes } from "./mirador/api.ts";

/** A to-do as written on one line: its text, and the time its words named. */
export interface WrittenTodo {
  text: string;
  dueAt: number | null;
}

/** Words that lead into a time and mean nothing once it's taken off: "send the report by friday". */
const LEAD_IN = /\s+(?:by|on|at|for|until|before|due)$/i;

/** A lone number such as "21" in "upgrade to java 21" is more often part of the task than a time. */
const isBareNumber = (phrase: string) => /^\d{1,2}$/.test(phrase.trim());

/** The time a whole phrase names, with nothing left over; null when it names none, or only a bare number. */
function wholeTime(phrase: string, now: Date, { readTime }: ReadsTimes): Date | null {
  if (isBareNumber(phrase)) return null;
  const read = readTime(phrase, now);
  return read && read.rest === "" ? read.at : null;
}

/**
 * Reads a to-do line whose time, in plain words, ends it ("send the summary fri 14:00") or starts it ("tomorrow call
 * the bank"). The longest ending that names a time wins; a line that names none is all text.
 */
export function readTodoLine(line: string, now: Date, times: ReadsTimes): WrittenTodo {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const textBefore = (count: number) => words.slice(0, count).join(" ").replace(LEAD_IN, "");
  const endingAt = words.slice(1).map((_, index) => index + 1).find((first) => wholeTime(words.slice(first).join(" "), now, times) !== null);
  if (endingAt !== undefined) return { text: textBefore(endingAt), dueAt: wholeTime(words.slice(endingAt).join(" "), now, times)!.getTime() };
  const leading = times.readTime(line, now);
  const leadingWord = words[0] ?? "";
  if (leading && leading.rest !== "" && !isBareNumber(leadingWord)) return { text: leading.rest, dueAt: leading.at.getTime() };
  return { text: words.join(" "), dueAt: null };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A date alone, at the start of the user's morning. */
function morningOf(isoDate: string, { morningMinutes }: ReadsTimes): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  const morning = morningMinutes();
  return new Date(year!, month! - 1, day!, Math.floor(morning / 60), morning % 60).getTime();
}

/**
 * A due time given as ISO 8601 ("2026-11-28T14:00:00+01:00", or a date alone, which means its morning) or in plain words
 * ("fri 14:00"). Throws, saying what would work, for anything else.
 */
export function readDue(written: string, now: Date, times: ReadsTimes): number {
  const due = written.trim();
  if (ISO_DATE.test(due)) return morningOf(due, times);
  const iso = ISO_DATE_TIME.test(due) ? Date.parse(due) : Number.NaN;
  if (Number.isFinite(iso)) return iso;
  const inWords = wholeTime(due, now, times);
  if (inWords) return inWords.getTime();
  throw new Error(`"${written}" isn't a time I can read. Give ISO 8601, such as 2026-11-28T14:00:00+01:00, or plain words such as "fri 14:00", "tomorrow" or "in 3h".`);
}
