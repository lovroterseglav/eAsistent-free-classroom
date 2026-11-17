import assert from "node:assert/strict";
import test from "node:test";
import { AppError, EasistentService, type RetryWait, type UpstreamFetcher } from "../src/easistent.js";
import { CLASS_PAGE, ROOM_INDEX_PAGE, ROOM_ONE_URL, SCHOOL_URL } from "./fixtures/timetables.js";

function html(value: string): Response {
  return new Response(value, { status: 200, headers: { "content-type": "text/html" } });
}

for (const failure of ["network", "status"] as const) {
  test(`retries a transient ${failure} failure three times before succeeding`, async () => {
    let attempts = 0;
    const delays: number[] = [];
    const fetcher: UpstreamFetcher = async (input) => {
      const url = String(input);
      if (url === ROOM_ONE_URL) return html(ROOM_INDEX_PAGE);
      attempts += 1;
      if (attempts <= 3) {
        if (failure === "network") throw new TypeError("temporary network failure");
        return new Response("unavailable", { status: 503, headers: { "content-type": "text/html" } });
      }
      return html(CLASS_PAGE);
    };
    const wait: RetryWait = async (milliseconds) => {
      delays.push(milliseconds);
    };
    const result = await new EasistentService(fetcher, undefined, wait).inspect(SCHOOL_URL);
    assert.equal(result.inspection.school.name, "Gimnazija Kranj");
    assert.equal(attempts, 4);
    assert.deepEqual(delays, [250, 500, 1_000]);
  });
}

test("does not retry a permanent not-found response", async () => {
  let attempts = 0;
  const fetcher: UpstreamFetcher = async () => {
    attempts += 1;
    return new Response("missing", { status: 404, headers: { "content-type": "text/html" } });
  };
  const service = new EasistentService(fetcher, undefined, async () => {
    throw new Error("wait should not be called");
  });
  await assert.rejects(service.inspect(SCHOOL_URL), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "TIMETABLE_NOT_FOUND");
    return true;
  });
  assert.equal(attempts, 1);
});

test("stops after the initial request and three retries", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const service = new EasistentService(async () => {
    attempts += 1;
    throw new TypeError("offline");
  }, undefined, async (milliseconds) => {
    delays.push(milliseconds);
  });
  await assert.rejects(service.inspect(SCHOOL_URL), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "UPSTREAM_UNREACHABLE");
    return true;
  });
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [250, 500, 1_000]);
});
