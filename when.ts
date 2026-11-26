/**
 * Times in plain words, as Mirador's /remind reads them: "9", "tomorrow 9", "mon", "fri 14:30", "3h", "in 30 min". The
 * phrase parser is a copy of Mirador's shared/reminders.ts, which plugins can't import; keep the two in step.
 */

/** Minutes after midnight that "morning" means, as Mirador's default. */
export const MORNING_MINUTES = 9 * 60;
export const EVENING_MINUTES = 18 * 60;
/** Before this hour, "tomorrow morning" is still the morning ahead, as the user hasn't slept yet. */
const NIGHT_ENDS_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const atMinutes = (day: Date, minutes: number) => {
  const time = new Date(day);
  time.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return time;
};

const daysAfter = (day: Date, days: number) => {
  const later = new Date(day);
  later.setDate(later.getDate() + days);
  return later;
};

/** The day "tomorrow" means: today until the night ends, as nobody has slept yet. */
const tomorrowOf = (now: Date) => (now.getHours() < NIGHT_ENDS_HOUR ? now : daysAfter(now, 1));

/** The coming Monday, a week on if today is Monday. */
export const nextWeekMorning = (now: Date, morning: number) => atMinutes(daysAfter(now, ((8 - now.getDay()) % 7) || 7), morning);

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DURATION_UNITS: Record<string, number> = { m: MINUTE_MS, h: HOUR_MS, d: 24 * HOUR_MS };

const durationPattern = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/;
const clockPattern = /^(?:at\s+)?(noon|midnight|(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)(?=\s|$)/;
const dayPattern = /^(today|tonight|this evening|evening|morning|tomorrow|tmrw?|next week|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)(?=\s|$)/;

/** Minutes after midnight a clock time names, as 24-hour unless it says am or pm. */
function clockMinutes(match: RegExpExecArray): number | null {
  const [, word, hourText, minuteText, half] = match;
  if (word === "noon") return 12 * 60;
  if (word === "midnight") return 0;
  const hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (minute > 59 || hour > (half ? 12 : 23) || (half && hour === 0)) return null;
  const in24 = half === "pm" ? (hour % 12) + 12 : half === "am" ? hour % 12 : hour;
  return in24 * 60 + minute;
}

interface DayWord {
  day: (now: Date) => Date;
  /** The time of day it means when no time follows. */
  defaultMinutes: (morning: number) => number;
  /** A bare time later than now stays today; a weekday and tomorrow already name their day. */
  rollsOver?: true;
}

function dayWord(word: string, now: Date): DayWord {
  const weekday = WEEKDAYS.indexOf(word.slice(0, 3));
  if (weekday >= 0 && /^(sun|mon|tue|wed|thu|fri|sat)/.test(word)) {
    const ahead = ((weekday - now.getDay() + 7) % 7) || 7;
    return { day: () => daysAfter(now, ahead), defaultMinutes: (morning) => morning };
  }
  switch (word) {
    case "today":
      return { day: () => now, defaultMinutes: () => EVENING_MINUTES };
    case "tonight":
    case "this evening":
    case "evening":
      return { day: () => now, defaultMinutes: () => EVENING_MINUTES, rollsOver: true };
    case "morning":
      return { day: () => now, defaultMinutes: (morning) => morning, rollsOver: true };
    case "next week":
      return { day: () => nextWeekMorning(now, 0), defaultMinutes: (morning) => morning };
    default:
      return { day: () => tomorrowOf(now), defaultMinutes: (morning) => morning };
  }
}

export interface ParsedReminder {
  at: Date;
  /** What follows the time: the note. */
  rest: string;
}

/**
 * The time a phrase starts with, such as "9", "tomorrow 9", "mon", "fri 14:30", "3h" or "in 30 min", and what follows it;
 * null when it names no time still ahead. The words are English only.
 */
export function parseReminderTime(text: string, now: Date, morning = MORNING_MINUTES): ParsedReminder | null {
  const phrase = text.trim().replace(/\s+/g, " ");
  const lower = phrase.toLowerCase();
  const restAfter = (length: number) => phrase.slice(length).trim();

  const duration = durationPattern.exec(lower);
  if (duration) {
    const [whole, amount, unit] = duration;
    const at = new Date(now.getTime() + Number(amount) * DURATION_UNITS[unit![0]!]!);
    return at > now ? { at, rest: restAfter(whole.length) } : null;
  }

  const day = dayPattern.exec(lower);
  const afterDay = day ? lower.slice(day[0].length).trimStart() : lower;
  const clock = clockPattern.exec(afterDay);
  if (!day && !clock) return null;
  const minutes = clock ? clockMinutes(clock) : null;
  if (clock && minutes === null) return null;
  const consumed = lower.length - afterDay.length + (clock?.[0].length ?? 0);

  const named = day ? dayWord(day[1]!, now) : null;
  let at = atMinutes(named ? named.day(now) : now, minutes ?? named!.defaultMinutes(morning));
  if (at <= now && (!named || named.rollsOver)) at = daysAfter(at, 1);
  return at > now ? { at, rest: restAfter(consumed) } : null;
}

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
function wholeTime(phrase: string, now: Date): Date | null {
  if (isBareNumber(phrase)) return null;
  const parsed = parseReminderTime(phrase, now);
  return parsed && parsed.rest === "" ? parsed.at : null;
}

/**
 * Reads a to-do line whose time, in plain words, ends it ("send the summary fri 14:00") or starts it ("tomorrow call
 * the bank"). The longest ending that names a time wins; a line that names none is all text.
 */
export function readTodoLine(line: string, now: Date): WrittenTodo {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const textBefore = (count: number) => words.slice(0, count).join(" ").replace(LEAD_IN, "");
  const endingAt = words.slice(1).map((_, index) => index + 1).find((first) => wholeTime(words.slice(first).join(" "), now) !== null);
  if (endingAt !== undefined) return { text: textBefore(endingAt), dueAt: wholeTime(words.slice(endingAt).join(" "), now)!.getTime() };
  const leading = parseReminderTime(line, now);
  const leadingWord = words[0] ?? "";
  if (leading && leading.rest !== "" && !isBareNumber(leadingWord)) return { text: leading.rest, dueAt: leading.at.getTime() };
  return { text: words.join(" "), dueAt: null };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * A due time given as ISO 8601 ("2026-11-28T14:00:00+01:00", or a date alone, which means its morning) or in plain words
 * ("fri 14:00"). Throws, saying what would work, for anything else.
 */
export function readDue(written: string, now: Date): number {
  const due = written.trim();
  if (ISO_DATE.test(due)) {
    const [year, month, day] = due.split("-").map(Number);
    return new Date(year!, month! - 1, day!, Math.floor(MORNING_MINUTES / 60), MORNING_MINUTES % 60).getTime();
  }
  const iso = ISO_DATE_TIME.test(due) ? Date.parse(due) : Number.NaN;
  if (Number.isFinite(iso)) return iso;
  const inWords = wholeTime(due, now);
  if (inWords) return inWords.getTime();
  throw new Error(`"${written}" isn't a time I can read. Give ISO 8601, such as 2026-11-28T14:00:00+01:00, or plain words such as "fri 14:00", "tomorrow" or "in 3h".`);
}
