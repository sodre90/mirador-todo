import type { ReadsTimes } from "../mirador/api.ts";

const on = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

/**
 * The phrases these tests use, as Mirador reads them on Thursday 26 November 2026 at 10:30 with a 9:00 morning. Bare
 * numbers read as hours, as Mirador's do, so To-do's own refusal of them is what keeps them text.
 */
const THURSDAY_MORNING: Record<string, Date> = {
  "fri 14:00": on(27, 14),
  fri: on(27, 9),
  friday: on(27, 9),
  "mon 9:00": on(30, 9),
  "mon 9:15": on(30, 9, 15),
  tomorrow: on(27, 9),
  "this evening": on(26, 18),
  "next week": on(30, 9),
  "in 3h": on(26, 13, 30),
  "in 30 min": on(26, 11),
  "15:30": on(26, 15, 30),
  "21": on(26, 21),
  "3": on(27, 3),
  "2": on(27, 2),
};

/** Mirador's readTime for those phrases, each read from the start of the text as Mirador reads it; Mirador's own tests cover the reading itself. */
export function timesOnThursdayMorning(morningMinutes = 9 * 60): ReadsTimes {
  const longestFirst = Object.keys(THURSDAY_MORNING).sort((a, b) => b.length - a.length);
  return {
    readTime: (text) => {
      const words = text.trim().replace(/\s+/g, " ");
      const lower = words.toLowerCase();
      const phrase = longestFirst.find((known) => lower === known || lower.startsWith(`${known} `));
      return phrase === undefined ? null : { at: THURSDAY_MORNING[phrase]!, rest: words.slice(phrase.length).trim() };
    },
    morningMinutes: () => morningMinutes,
  };
}
