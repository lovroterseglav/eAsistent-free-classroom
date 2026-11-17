import assert from "node:assert/strict";
import test from "node:test";
import { EasistentService, schoolWeekNumber, schoolYearBounds, type UpstreamFetcher } from "../src/easistent.js";
import {
  CLASS_AJAX_URL,
  CLASS_PAGE,
  ROOM_CANCELLED_PAGE,
  ROOM_INDEX_PAGE,
  ROOM_ONE_AJAX_URL,
  ROOM_ONE_URL,
  ROOM_TWO_AJAX_URL,
  ROOM_TWO_URL,
  SCHOOL_URL,
  pageForDate,
} from "./fixtures/timetables.js";

function response(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}

test("calculates formal school-year bounds and school week numbers", () => {
  const bounds = schoolYearBounds("2027-01-12");
  assert.deepEqual(bounds, { start: "2026-09-01", end: "2027-08-31" });
  assert.equal(schoolWeekNumber("2026-09-01", bounds), 1);
  assert.equal(schoolWeekNumber("2026-11-17", bounds), 12);
  assert.equal(schoolWeekNumber("2026-11-27", bounds), 13);
  assert.equal(schoolWeekNumber("2027-08-31", bounds), 53);
  assert.equal(schoolWeekNumber("2026-08-31", bounds), null);
  assert.equal(schoolWeekNumber("2027-02-29", bounds), null);
});

test("requests the target school week for the school and every classroom", async () => {
  const requested: Array<{ url: string; init: RequestInit | undefined }> = [];
  const targetClassUrl = CLASS_AJAX_URL.replace("/12/0/1", "/13/0/1");
  const targetRoomOneUrl = ROOM_ONE_AJAX_URL.replace("/12/0/1", "/13/0/1");
  const targetRoomTwoUrl = ROOM_TWO_AJAX_URL.replace("/12/0/1", "/13/0/1");
  const pages = new Map([
    [SCHOOL_URL, CLASS_PAGE],
    [ROOM_ONE_URL, ROOM_INDEX_PAGE],
    [ROOM_TWO_URL, ROOM_CANCELLED_PAGE],
    [targetClassUrl, pageForDate("2026-11-27")],
    [targetRoomOneUrl, pageForDate("2026-11-27")],
    [targetRoomTwoUrl, pageForDate("2026-11-27", true)],
  ]);
  const fetcher: UpstreamFetcher = async (input, init) => {
    const url = String(input);
    requested.push({ url, init });
    const page = pages.get(url);
    return page ? response(page) : new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };
  const service = new EasistentService(fetcher, undefined, undefined, () => "2026-11-17");
  const result = await service.availability(SCHOOL_URL, "2026-11-27", 1);
  assert.equal(result.date, "2026-11-27");
  assert.deepEqual(result.rooms.free.map(({ name }) => name), ["1"]);
  assert.equal(result.rooms.occupiedCount, 1);
  const ajaxRequests = requested.filter(({ url }) => url.includes("/ajax_urnik/"));
  assert.equal(ajaxRequests.length, 3);
  assert.ok(ajaxRequests.every(({ url }) => url.includes("/13/0/1") && !new URL(url).search));
  assert.ok(ajaxRequests.every(({ init }) => init?.method === "GET"));
  assert.ok(ajaxRequests.every(({ init }) => new Headers(init?.headers).get("X-Requested-With") === "XMLHttpRequest"));
  assert.ok(ajaxRequests.every(({ init }) => !new Headers(init?.headers).has("Cookie")));
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
