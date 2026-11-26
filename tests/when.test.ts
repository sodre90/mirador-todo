import { describe, expect, test } from "bun:test";
import { readDue, readTodoLine } from "../when.ts";
import { timesOnThursdayMorning } from "./times.ts";

/** Thursday 26 November 2026, 10:30 on the Mac's own clock. */
const now = new Date(2026, 10, 26, 10, 30);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const times = timesOnThursdayMorning();

describe("readTodoLine", () => {
  test("a time at the end of the line is the due time, and the words before it the text", () => {
    expect(readTodoLine("send the summary fri 14:00", now, times)).toEqual({ text: "send the summary", dueAt: at(27, 14) });
    expect(readTodoLine("call the bank tomorrow", now, times)).toEqual({ text: "call the bank", dueAt: at(27, 9) });
    expect(readTodoLine("check the build in 3h", now, times)).toEqual({ text: "check the build", dueAt: at(26, 13, 30) });
  });

  test("a word leading into the time goes with it", () => {
    expect(readTodoLine("send the report by friday", now, times)).toEqual({ text: "send the report", dueAt: at(27, 9) });
    expect(readTodoLine("standup notes at 15:30", now, times)).toEqual({ text: "standup notes", dueAt: at(26, 15, 30) });
  });

  test("a time at the start of the line counts when none ends it", () => {
    expect(readTodoLine("tomorrow call the bank", now, times)).toEqual({ text: "call the bank", dueAt: at(27, 9) });
    expect(readTodoLine("mon 9:15 review the release notes", now, times)).toEqual({ text: "review the release notes", dueAt: at(30, 9, 15) });
  });

  test("a lone number is part of the task, not a time", () => {
    expect(readTodoLine("upgrade to java 21", now, times)).toEqual({ text: "upgrade to java 21", dueAt: null });
    expect(readTodoLine("3 flaky tests to look at", now, times)).toEqual({ text: "3 flaky tests to look at", dueAt: null });
    expect(readTodoLine("fix 2 bugs", now, times)).toEqual({ text: "fix 2 bugs", dueAt: null });
  });

  test("a line that names no time is all text, its spaces tidied", () => {
    expect(readTodoLine("  write   the  release notes ", now, times)).toEqual({ text: "write the release notes", dueAt: null });
    expect(readTodoLine("tomorrow", now, times)).toEqual({ text: "tomorrow", dueAt: null });
  });
});

describe("readDue", () => {
  test("reads ISO 8601 with its offset as that moment", () => {
    expect(readDue("2026-11-28T14:00:00+01:00", now, times)).toBe(Date.parse("2026-11-28T13:00:00Z"));
  });

  test("a date alone means the user's morning on the Mac's clock", () => {
    expect(readDue("2026-12-01", now, times)).toBe(new Date(2026, 11, 1, 9, 0).getTime());
    expect(readDue("2026-12-01", now, timesOnThursdayMorning(7 * 60 + 30))).toBe(new Date(2026, 11, 1, 7, 30).getTime());
  });

  test("reads plain words", () => {
    expect(readDue("fri 14:00", now, times)).toBe(at(27, 14));
    expect(readDue("in 30 min", now, times)).toBe(at(26, 11));
  });

  test("says what would work for words it can't read", () => {
    expect(() => readDue("after lunch", now, times)).toThrow(/ISO 8601/);
    expect(() => readDue("21", now, times)).toThrow(/plain words/);
  });
});
