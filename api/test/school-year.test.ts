import assert from "node:assert/strict";
import test from "node:test";
import { EasistentService, schoolWeekNumber, schoolYearBounds, type UpstreamFetcher } from "../src/easistent.js";
import { CLASS_PAGE, ROOM_INDEX_PAGE, ROOM_ONE_URL, SCHOOL_URL } from "./fixtures/timetables.js";

function response(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}

test("calculates formal school-year bounds and ISO week numbers", () => {
  const bounds = schoolYearBounds("2027-01-12");
  assert.deepEqual(bounds, { start: "2026-09-01", end: "2027-08-31" });
  assert.equal(schoolWeekNumber("2026-09-01", bounds), 36);
  assert.equal(schoolWeekNumber("2026-11-17", bounds), 47);
  assert.equal(schoolWeekNumber("2026-11-27", bounds), 48);
  assert.equal(schoolWeekNumber("2027-01-01", bounds), 53);
  assert.equal(schoolWeekNumber("2027-01-04", bounds), 1);
  assert.equal(schoolWeekNumber("2027-08-31", bounds), 35);
  assert.equal(schoolWeekNumber("2026-08-31", bounds), null);
  assert.equal(schoolWeekNumber("2027-02-29", bounds), null);
});

test("requests the target school week for the school and every classroom", async () => {
  const requested: string[] = [];
  const fetcher: UpstreamFetcher = async (input) => {
    const url = new URL(String(input));
    requested.push(url.href);
    const base = new URL(url);
    base.searchParams.delete("teden");
    if (base.href === SCHOOL_URL) return response(CLASS_PAGE.replaceAll("2026-11-17", "2026-11-27"));
    if (base.href === ROOM_ONE_URL) return response(ROOM_INDEX_PAGE.replaceAll("2026-11-17", "2026-11-27"));
    return response(ROOM_INDEX_PAGE.replaceAll("2026-11-17", "2026-11-27"));
  };
  const service = new EasistentService(fetcher, undefined, undefined, () => "2026-11-17");
  const result = await service.availability(SCHOOL_URL, "2026-11-27", 1);
  assert.equal(result.date, "2026-11-27");
  assert.ok(requested.length >= 3);
  assert.ok(requested.every((url) => new URL(url).searchParams.get("teden") === "48"));
});

test("rejects invalid, out-of-year, and missing timetable dates", async () => {
  const fetcher: UpstreamFetcher = async (input) => {
    const url = new URL(String(input));
    url.searchParams.delete("teden");
    return url.href === SCHOOL_URL ? response(CLASS_PAGE) : response(ROOM_INDEX_PAGE);
  };
  const service = new EasistentService(fetcher, undefined, undefined, () => "2026-11-17");
  await assert.rejects(service.availability(SCHOOL_URL, "2027-02-29", 1), { code: "INVALID_DATE" });
  await assert.rejects(service.availability(SCHOOL_URL, "2028-01-10", 1), { code: "DATE_OUTSIDE_SCHOOL_YEAR" });
  await assert.rejects(service.availability(SCHOOL_URL, "2026-11-21", 1), { code: "DATE_NOT_IN_TIMETABLE" });
});
