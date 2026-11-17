import assert from "node:assert/strict";
import test from "node:test";
import { chooseInitialSchedule, localClock } from "../dist/schedule-state.mjs";

const periods = [
  { number: 1, startMinute: 430, endMinute: 475 },
  { number: 2, startMinute: 480, endMinute: 525 },
];
const dates = ["2026-11-16", "2026-11-17"];

test("selects today and the active period", () => {
  assert.deepEqual(chooseInitialSchedule(dates, periods, { date: "2026-11-17", minute: 430 }), {
    date: "2026-11-17",
    periodNumber: 1,
  });
  assert.equal(chooseInitialSchedule(dates, periods, { date: "2026-11-17", minute: 524 }).periodNumber, 2);
});

test("falls back independently to the first date and period", () => {
  assert.deepEqual(chooseInitialSchedule(dates, periods, { date: "2026-11-18", minute: 477 }), {
    date: "2026-11-16",
    periodNumber: 1,
  });
  assert.deepEqual(chooseInitialSchedule([], [], { date: "2026-11-18", minute: 477 }), {
    date: "",
    periodNumber: null,
  });
});

test("treats a period end as exclusive", () => {
  const touchingPeriods = [periods[0], { number: 2, startMinute: 475, endMinute: 520 }];
  assert.equal(chooseInitialSchedule(dates, touchingPeriods, { date: "2026-11-17", minute: 475 }).periodNumber, 2);
});

test("builds a local browser clock", () => {
  assert.deepEqual(localClock(new Date(2026, 10, 17, 9, 45)), { date: "2026-11-17", minute: 585 });
});
