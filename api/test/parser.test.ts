import assert from "node:assert/strict";
import test from "node:test";
import {
  ajaxTimetableUrl,
  naturalRoomSort,
  parseClassrooms,
  parseScheduleMetadata,
  roomAvailability,
} from "../src/parser.js";
import { CLASS_PAGE, ROOM_CANCELLED_PAGE, ROOM_FREE_PAGE, ROOM_INDEX_PAGE, ROOM_ONE_URL } from "./fixtures/timetables.js";

test("parses current schedule metadata", () => {
  const metadata = parseScheduleMetadata(CLASS_PAGE);
  assert.equal(metadata.schoolName, "Gimnazija Kranj");
  assert.deepEqual(metadata.dates, ["2026-11-17"]);
  assert.deepEqual(metadata.periods, [{ number: 1, label: "1. ura", startMinute: 430, endMinute: 475 }]);
});

test("constructs a target-week AJAX URL from a captured path", () => {
  const html = `<script>const url = "\\/urniki\\/ajax_urnik\\/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33\\/815595\\/0\\/0\\/0\\/12\\/0\\/1";</script>`;
  assert.equal(
    ajaxTimetableUrl(html, "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/razredi/748283", 13),
    "https://urniki.easistent.com/urniki/ajax_urnik/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/815595/0/0/0/13/0/1",
  );
});

test("constructs an AJAX URL from page variables without trusting foreign tokens", () => {
  const source = "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/ucilnice/1333027";
  const variables = `<script>var id_razred='0'; var id_profesor='0'; var id_dijak='0'; var id_ucilnica='9123'; var id_interesna_dejavnost='0';</script>`;
  assert.equal(
    ajaxTimetableUrl(variables, source, 13),
    "https://urniki.easistent.com/urniki/ajax_urnik/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/0/0/0/9123/13/0/1",
  );
  const foreign = variables + "/urniki/ajax_urnik/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/0/0/0/9123/12/0/1";
  assert.equal(ajaxTimetableUrl(foreign, source, 13), null);
  assert.equal(ajaxTimetableUrl(variables, "https://example.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/ucilnice/1333027", 13), null);
  assert.equal(ajaxTimetableUrl(variables, "not a URL", 13), null);
});

test("discovers numeric classroom options", () => {
  const rooms = parseClassrooms(ROOM_INDEX_PAGE, ROOM_ONE_URL);
  assert.deepEqual(rooms.map(({ name }) => name), ["1", "11"]);
  assert.ok(rooms[1]?.url.endsWith("/ucilnice/1333035"));
});

test("treats empty and cancelled room cells as free", () => {
  assert.equal(roomAvailability(ROOM_FREE_PAGE, "2026-11-17", 1), "free");
  assert.equal(roomAvailability(ROOM_CANCELLED_PAGE, "2026-11-17", 1), "free");
  assert.equal(roomAvailability(ROOM_FREE_PAGE, "2026-11-17", 2), "unknown");
});

test("sorts classroom names naturally", () => {
  const rooms = [{ name: "11" }, { name: "bazen" }, { name: "2" }].sort(naturalRoomSort);
  assert.deepEqual(rooms.map(({ name }) => name), ["2", "11", "bazen"]);
});
