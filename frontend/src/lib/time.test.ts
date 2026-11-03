import { describe, expect, it } from "vitest";
import { duration, nextQuarterHour, offsetMinutes, wallTime, weekdayClock, withOffset } from "./time";

describe("withOffset", () => {
  it.each([
    ["2026-11-04T08:00", "America/Chicago", "2026-11-04T08:00-06:00"],
    ["2026-07-04T08:00", "America/Chicago", "2026-07-04T08:00-05:00"],
    ["2026-11-04T08:00", "America/Los_Angeles", "2026-11-04T08:00-08:00"],
    ["2026-11-04T08:00", "Asia/Kolkata", "2026-11-04T08:00+05:30"],
    ["2026-11-04T08:00", "UTC", "2026-11-04T08:00+00:00"],
  ])("%s in %s is %s", (local, zone, expected) => {
    expect(withOffset(local, zone)).toBe(expected);
  });

  it("names the same instant the wall time shows in that zone", () => {
    for (const zone of ["America/New_York", "America/Denver", "America/Phoenix", "Pacific/Honolulu"]) {
      const iso = withOffset("2026-12-24T23:45", zone);
      expect(wallTime(Date.parse(iso), zone)).toBe("2026-12-24T23:45");
    }
  });

  it("gives a time on a clock-change night one of that night's two offsets", () => {
    for (const local of ["2026-11-01T01:30", "2026-03-08T02:30"]) {
      expect(withOffset(local, "America/Chicago")).toMatch(/-0[56]:00$/);
    }
  });

  it("refuses text that is not a wall time", () => {
    expect(() => withOffset("tomorrow", "UTC")).toThrow(RangeError);
  });
});

describe("clock helpers", () => {
  it("measures offsets in minutes east of UTC", () => {
    expect(offsetMinutes(Date.parse("2026-11-04T14:00Z"), "America/Denver")).toBe(-420);
    expect(offsetMinutes(Date.parse("2026-07-04T14:00Z"), "America/Denver")).toBe(-360);
  });

  it("rounds up to the next quarter hour, at least a minute ahead", () => {
    expect(nextQuarterHour("UTC", new Date("2026-11-04T13:59:30Z"))).toBe("2026-11-04T14:15");
    expect(nextQuarterHour("UTC", new Date("2026-11-04T13:50:00Z"))).toBe("2026-11-04T14:00");
    expect(nextQuarterHour("America/New_York", new Date("2026-11-04T13:59:30Z"))).toBe("2026-11-04T09:15");
  });

  it("formats durations and weekday clocks", () => {
    expect(duration(45 * 60)).toBe("45 m");
    expect(duration(3 * 3600)).toBe("3 h");
    expect(duration(26 * 3600 + 24 * 60)).toBe("26 h 24 m");
    expect(weekdayClock("2026-11-04T14:05:00-06:00", "America/Chicago")).toBe("Wed 14:05");
  });
});
