import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { INITIAL_SCHOOL, SchoolCatalog, timetableUrlForToken } from "../src/catalog.js";
import { EasistentService, parsePublicTimetableUrl, type UpstreamFetcher } from "../src/easistent.js";
import {
  CLASS_PAGE,
  ROOM_CANCELLED_PAGE,
  ROOM_FREE_PAGE,
  ROOM_INDEX_PAGE,
  ROOM_ONE_URL,
  ROOM_TWO_URL,
  SCHOOL_ROOT,
  SCHOOL_URL,
} from "./fixtures/timetables.js";

function response(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function service(): EasistentService {
  const pages = new Map([
    [SCHOOL_URL, CLASS_PAGE],
    [ROOM_ONE_URL, ROOM_INDEX_PAGE],
    [ROOM_TWO_URL, ROOM_CANCELLED_PAGE],
  ]);
  const fetcher: UpstreamFetcher = async (input) => {
    const url = String(input);
    if (url === ROOM_ONE_URL) {
      const hits = fetcherHits.get(url) ?? 0;
      fetcherHits.set(url, hits + 1);
      return response(hits === 0 ? ROOM_INDEX_PAGE : ROOM_FREE_PAGE);
    }
    const page = pages.get(url);
    return page ? response(page) : new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };
  const fetcherHits = new Map<string, number>();
  return new EasistentService(fetcher);
}

test("health endpoint is available", async () => {
  const app = await buildApp({ service: service() });
  const result = await app.inject({ method: "GET", url: "/api/v1/health" });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().ok, true);
  await app.close();
});

test("inspect returns school dates, periods, and classroom count", async () => {
  const catalog = SchoolCatalog.memory([]);
  const app = await buildApp({ service: service(), catalog });
  const result = await app.inject({ method: "POST", url: "/api/v1/schools/inspect", payload: { timetableUrl: SCHOOL_URL } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().school.name, "Gimnazija Kranj");
  assert.equal(result.json().classroomCount, 2);
  const listed = await app.inject({ method: "GET", url: "/api/v1/schools" });
  assert.deepEqual(listed.json(), {
    v: 1,
    schools: [{ ...INITIAL_SCHOOL, timetableUrl: timetableUrlForToken(INITIAL_SCHOOL.token) }],
  });
  await app.close();
});

test("availability returns free rooms", async () => {
  const catalog = SchoolCatalog.memory([]);
  const app = await buildApp({ service: service(), catalog });
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/availability",
    payload: { timetableUrl: SCHOOL_URL, date: "2026-11-17", period: 1 },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().rooms.free.map((room: { name: string }) => room.name), ["1", "11"]);
  assert.equal(catalog.get(INITIAL_SCHOOL.token)?.name, "Gimnazija Kranj");
  await app.close();
});

test("rejects arbitrary upstream hosts", async () => {
  const app = await buildApp({ service: service() });
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/schools/inspect",
    payload: { timetableUrl: "https://example.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33" },
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.json().error.code, "INVALID_TIMETABLE_URL");
  await app.close();
});

test("accepts and uses the classroom collection page", async () => {
  const indexUrl = "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/ucilnice";
  assert.equal(parsePublicTimetableUrl(indexUrl).url, indexUrl);
  const classPageWithoutRoomLink = CLASS_PAGE.replace(/\s*<a[^>]+>Učilnice<\/a>/, "");
  const fetcher: UpstreamFetcher = async (input) => {
    const url = String(input);
    if (url === SCHOOL_URL) return response(classPageWithoutRoomLink);
    if (url === indexUrl) return response(ROOM_INDEX_PAGE);
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };
  const app = await buildApp({ service: new EasistentService(fetcher) });
  const result = await app.inject({ method: "POST", url: "/api/v1/schools/inspect", payload: { timetableUrl: SCHOOL_URL } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().classroomCount, 2);
  await app.close();
});

test("inspects a school using only its constructed root URL", async () => {
  const fetcher: UpstreamFetcher = async (input) => {
    const url = String(input);
    if (url === SCHOOL_ROOT) return response(CLASS_PAGE);
    if (url === ROOM_ONE_URL) return response(ROOM_INDEX_PAGE);
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };
  const app = await buildApp({ service: new EasistentService(fetcher) });
  const result = await app.inject({ method: "POST", url: "/api/v1/schools/inspect", payload: { timetableUrl: SCHOOL_ROOT } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().school.name, "Gimnazija Kranj");
  assert.equal(result.json().classroomCount, 2);
  await app.close();
});

test("removes a stored root URL after a definitive not-found response", async () => {
  const catalog = SchoolCatalog.memory();
  const fetcher: UpstreamFetcher = async () => new Response("gone", {
    status: 410,
    headers: { "content-type": "text/html" },
  });
  const app = await buildApp({ service: new EasistentService(fetcher), catalog });
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/schools/inspect",
    payload: { timetableUrl: timetableUrlForToken(INITIAL_SCHOOL.token) },
  });
  assert.equal(result.statusCode, 404);
  assert.equal(result.json().error.code, "TIMETABLE_NOT_FOUND");
  assert.equal(catalog.get(INITIAL_SCHOOL.token), undefined);
  await app.close();
});

test("keeps a school after transient upstream and class-specific failures", async () => {
  for (const status of [404, 500]) {
    const catalog = SchoolCatalog.memory();
    const fetcher: UpstreamFetcher = async () => new Response("failed", {
      status,
      headers: { "content-type": "text/html" },
    });
    const app = await buildApp({ service: new EasistentService(fetcher, undefined, async () => {}), catalog });
    const timetableUrl = status === 404 ? SCHOOL_URL : timetableUrlForToken(INITIAL_SCHOOL.token);
    await app.inject({ method: "POST", url: "/api/v1/schools/inspect", payload: { timetableUrl } });
    assert.ok(catalog.get(INITIAL_SCHOOL.token));
    await app.close();
  }

  const catalog = SchoolCatalog.memory();
  const app = await buildApp({
    service: new EasistentService(async () => {
      throw new TypeError("DNS failed");
    }, undefined, async () => {}),
    catalog,
  });
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/schools/inspect",
    payload: { timetableUrl: timetableUrlForToken(INITIAL_SCHOOL.token) },
  });
  assert.equal(result.statusCode, 502);
  assert.equal(result.json().error.code, "UPSTREAM_UNREACHABLE");
  assert.ok(catalog.get(INITIAL_SCHOOL.token));
  await app.close();
});
