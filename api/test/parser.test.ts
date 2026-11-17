import assert from "node:assert/strict";
import test from "node:test";
import {
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
