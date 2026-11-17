import assert from "node:assert/strict";
import test from "node:test";
import {
  FALLBACK_TOKEN,
  chooseDefaultSchool,
  filterSchools,
  mergeSchools,
  normalizeSearch,
  timetableUrlForToken,
  tokenFromTimetableUrl,
} from "../dist/school-state.mjs";

const otherToken = "a".repeat(40);
const schools = mergeSchools(
  [{ token: otherToken, name: "Šolski center Črnuče" }],
  [{ token: FALLBACK_TOKEN, name: "Gimnazija Kranj" }],
);

test("search is case and accent insensitive", () => {
  assert.equal(normalizeSearch("  ŠOLA Črnuče "), "sola crnuce");
  assert.deepEqual(filterSchools(schools, "crnuce").map(({ token }) => token), [otherToken]);
  assert.equal(filterSchools([...schools, ...schools], "", 2).length, 2);
  assert.equal(filterSchools(schools, "", 50, otherToken)[0]?.token, otherToken);
});

test("merges by token and constructs stable root URLs", () => {
  const merged = mergeSchools(
    [{ token: otherToken.toUpperCase(), name: "Prvo ime", timetableUrl: "ignored" }],
    [{ token: otherToken, name: "Drugo ime" }],
  );
  assert.deepEqual(merged, [{ token: otherToken, name: "Prvo ime", timetableUrl: timetableUrlForToken(otherToken) }]);
  assert.equal(tokenFromTimetableUrl(`${timetableUrlForToken(otherToken)}/razredi/123`), otherToken);
});

test("chooses favorite, then Kranj, then the first school", () => {
  assert.equal(chooseDefaultSchool(schools, otherToken)?.token, otherToken);
  assert.equal(chooseDefaultSchool(schools, "f".repeat(40))?.token, FALLBACK_TOKEN);
  assert.equal(chooseDefaultSchool([schools[1]], null, "f".repeat(40))?.token, otherToken);
  assert.equal(chooseDefaultSchool([], null), null);
});
