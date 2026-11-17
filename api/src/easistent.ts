import { TimedLruCache } from "./cache.js";
import {
  classroomIndexCandidates,
  naturalRoomSort,
  parseClassrooms,
  parseScheduleMetadata,
  roomAvailability,
} from "./parser.js";
import type { AvailabilityResult, Classroom, InspectedSchool, RoomState } from "./types.js";

const ALLOWED_HOSTS = new Set(["urniki.easistent.com", "www.easistent.com"]);
const SCHOOL_TOKEN = /^[a-f0-9]{40}$/i;
const MAX_HTML_SIZE = 2 * 1024 * 1024;
const RETRY_DELAYS_MS = [250, 500, 1_000] as const;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

export interface PageResult {
  html: string;
  responseUrl: string;
}

export type UpstreamFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type RetryWait = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
export type TodayProvider = () => string;

export interface SchoolYearBounds {
  start: string;
  end: string;
}

export function schoolYearBounds(today: string): SchoolYearBounds {
  const parts = validDateParts(today);
  if (!parts) throw new Error("Today provider returned an invalid date");
  const startYear = parts.month >= 9 ? parts.year : parts.year - 1;
  return { start: `${startYear}-09-01`, end: `${startYear + 1}-08-31` };
}

export function schoolWeekNumber(date: string, bounds: SchoolYearBounds): number | null {
  const requested = validDateParts(date);
  if (!requested || date < bounds.start || date > bounds.end) return null;
  const start = dateAtNoonUtc(bounds.start)!;
  const startDay = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - (startDay === 0 ? 6 : startDay - 1));
  const target = dateAtNoonUtc(date)!;
  return Math.floor((target.getTime() - start.getTime()) / (7 * 86_400_000)) + 1;
}

export function parsePublicTimetableUrl(value: string): { url: string; schoolToken: string; schoolRoot: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError(400, "INVALID_TIMETABLE_URL", "Povezava do urnika ni veljavna.");
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new AppError(400, "INVALID_TIMETABLE_URL", "Dovoljene so samo javne HTTPS-povezave eAsistent.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "urniki" || !SCHOOL_TOKEN.test(segments[1] ?? "")) {
    throw new AppError(400, "INVALID_TIMETABLE_URL", "Povezava ne vsebuje veljavne oznake šole.");
  }
  if (segments.length > 2) {
    const knownEntity = ["razredi", "ucilnice"].includes(segments[2] ?? "");
    const collection = segments.length === 3;
    const singleEntity = segments.length === 4 && /^\d+$/.test(segments[3] ?? "");
    const student = segments.length === 6 && /^\d+$/.test(segments[3] ?? "") &&
      segments[4] === "dijak" && /^\d+$/.test(segments[5] ?? "");
    if (!knownEntity || (!collection && !singleEntity && !student)) {
      throw new AppError(400, "INVALID_TIMETABLE_URL", "Pot javnega urnika ni podprta.");
    }
  }
  url.hash = "";
  const schoolToken = segments[1]!.toLowerCase();
  return { url: url.href, schoolToken, schoolRoot: `${url.origin}/urniki/${schoolToken}` };
}

export class EasistentService {
  readonly pageCache: TimedLruCache<PageResult>;
  readonly #inflight = new Map<string, Promise<PageResult>>();

  constructor(
    readonly fetcher: UpstreamFetcher = fetch,
    cache = new TimedLruCache<PageResult>(),
    readonly retryWait: RetryWait = waitForRetry,
    readonly today: TodayProvider = currentDateInLjubljana,
  ) {
    this.pageCache = cache;
  }

  async inspect(timetableUrl: string, signal?: AbortSignal): Promise<InspectedSchool> {
    const parsedUrl = parsePublicTimetableUrl(timetableUrl);
    const seed = await this.fetchPage(parsedUrl.url, signal);
    const seedMetadata = parseScheduleMetadata(seed.html);
    if (!seedMetadata.schoolName || !seedMetadata.dates.length || !seedMetadata.periods.length) {
      throw new AppError(502, "UNSUPPORTED_TIMETABLE", "eAsistent ni vrnil prepoznavnega javnega urnika.");
    }

    let classrooms: Classroom[] = [];
    let roomMetadata = seedMetadata;
    for (const candidate of classroomIndexCandidates(seed.html, seed.responseUrl, parsedUrl.schoolRoot)) {
      try {
        const candidateUrl = inheritSchoolWeek(candidate, seed.responseUrl);
        const page = candidateUrl === seed.responseUrl ? seed : await this.fetchPage(candidateUrl, signal);
        const discovered = parseClassrooms(page.html, page.responseUrl);
        if (discovered.length) {
          classrooms = discovered.sort(naturalRoomSort);
          const metadata = parseScheduleMetadata(page.html);
          if (metadata.dates.length && metadata.periods.length) roomMetadata = metadata;
          break;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    if (!classrooms.length) {
      throw new AppError(502, "CLASSROOMS_NOT_FOUND", "Popolnega seznama učilnic ni bilo mogoče odkriti.");
    }

    return {
      inspection: {
        v: 1,
        school: {
          token: parsedUrl.schoolToken,
          name: seedMetadata.schoolName,
          canonicalUrl: seed.responseUrl,
        },
        dates: roomMetadata.dates,
        periods: roomMetadata.periods,
        schoolYear: schoolYearBounds(this.today()),
        classroomCount: classrooms.length,
        fetchedAt: new Date().toISOString(),
      },
      classrooms,
    };
  }

  async availability(timetableUrl: string, date: string, periodNumber: number, signal?: AbortSignal): Promise<AvailabilityResult> {
    const bounds = schoolYearBounds(this.today());
    const week = schoolWeekNumber(date, bounds);
    if (week === null) {
      const code = validDateParts(date) ? "DATE_OUTSIDE_SCHOOL_YEAR" : "INVALID_DATE";
      const message = validDateParts(date) ? "Datum ni v trenutnem šolskem letu." : "Datum ni veljaven.";
      throw new AppError(400, code, message);
    }
    let inspected: InspectedSchool;
    try {
      inspected = await this.inspect(withSchoolWeek(timetableUrl, week), signal);
    } catch (error) {
      if (error instanceof AppError && error.code === "TIMETABLE_NOT_FOUND") {
        throw new AppError(400, "DATE_NOT_IN_TIMETABLE", "Za izbrani datum urnik ni na voljo.");
      }
      throw error;
    }
    const period = inspected.inspection.periods.find((item) => item.number === periodNumber);
    if (!inspected.inspection.dates.includes(date) || !period) {
      if (!inspected.inspection.dates.includes(date)) {
        throw new AppError(400, "DATE_NOT_IN_TIMETABLE", "Za izbrani datum urnik ni na voljo.");
      }
      throw new AppError(400, "INVALID_SLOT", "Šolska ura ni del naloženega urnika.");
    }

    const states = await mapWithConcurrency(inspected.classrooms, 6, async (room) => {
      try {
        const page = await this.fetchPage(withSchoolWeek(room.url, week), signal);
        return { room, state: roomAvailability(page.html, date, periodNumber) };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { room, state: "unknown" as RoomState };
      }
    });
    const free = states.filter(({ state }) => state === "free").map(({ room }) => ({ id: room.id, name: room.name })).sort(naturalRoomSort);
    const unknown = states.filter(({ state }) => state === "unknown").map(({ room }) => ({ id: room.id, name: room.name })).sort(naturalRoomSort);
    return {
      v: 1,
      school: inspected.inspection.school,
      date,
      period,
      rooms: {
        free,
        unknown,
        occupiedCount: states.filter(({ state }) => state === "occupied").length,
        totalCount: states.length,
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  private async fetchPage(url: string, signal?: AbortSignal): Promise<PageResult> {
    const parsed = parsePublicTimetableUrl(url);
    const cached = this.pageCache.get(parsed.url);
    if (cached) return cached;
    const existing = this.#inflight.get(parsed.url);
    if (existing) return existing;
    const promise = this.fetchPageUncached(parsed.url, signal).finally(() => this.#inflight.delete(parsed.url));
    this.#inflight.set(parsed.url, promise);
    return promise;
  }

  private async fetchPageUncached(initialUrl: string, parentSignal?: AbortSignal): Promise<PageResult> {
    let current = initialUrl;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      parsePublicTimetableUrl(current);
      const response = await this.fetchWithRetry(current, parentSignal);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new AppError(502, "UPSTREAM_REDIRECT", "eAsistent je vrnil neveljavno preusmeritev.");
        current = new URL(location, current).href;
        parsePublicTimetableUrl(current);
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        throw new AppError(404, "TIMETABLE_NOT_FOUND", "Javni urnik ne obstaja več.", response.status);
      }
      if (!response.ok) throw new AppError(502, "UPSTREAM_STATUS", `eAsistent je vrnil HTTP ${response.status}.`, response.status);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/html")) {
        throw new AppError(502, "UPSTREAM_TYPE", "eAsistent ni vrnil HTML-strani.");
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > MAX_HTML_SIZE) throw new AppError(502, "UPSTREAM_SIZE", "Odgovor eAsistenta je prevelik.");
      const html = await response.text();
      if (html.length > MAX_HTML_SIZE) throw new AppError(502, "UPSTREAM_SIZE", "Odgovor eAsistenta je prevelik.");
      const value = { html, responseUrl: current };
      this.pageCache.set(initialUrl, value);
      this.pageCache.set(current, value);
      return value;
    }
    throw new AppError(502, "UPSTREAM_REDIRECT", "eAsistent je vrnil preveč preusmeritev.");
  }

  private async fetchWithRetry(url: string, parentSignal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const timeout = AbortSignal.timeout(10_000);
      const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
      try {
        const response = await this.fetcher(url, {
          method: "GET",
          headers: { Accept: "text/html", "User-Agent": "ProsteUcilnice/1.0" },
          redirect: "manual",
          signal,
        });
        if (!RETRYABLE_STATUS.has(response.status) || attempt === RETRY_DELAYS_MS.length) return response;
        await response.body?.cancel();
      } catch {
        if (parentSignal?.aborted) {
          throw new AppError(504, "UPSTREAM_TIMEOUT", "eAsistent se ni pravočasno odzval.");
        }
        if (attempt === RETRY_DELAYS_MS.length) {
          if (timeout.aborted) throw new AppError(504, "UPSTREAM_TIMEOUT", "eAsistent se ni pravočasno odzval.");
          throw new AppError(502, "UPSTREAM_UNREACHABLE", "Povezave z eAsistentom ni bilo mogoče vzpostaviti.");
        }
      }

      try {
        await this.retryWait(RETRY_DELAYS_MS[attempt]!, parentSignal);
      } catch {
        throw new AppError(504, "UPSTREAM_TIMEOUT", "eAsistent se ni pravočasno odzval.");
      }
    }
    throw new AppError(502, "UPSTREAM_UNREACHABLE", "Povezave z eAsistentom ni bilo mogoče vzpostaviti.");
  }
}

function withSchoolWeek(value: string, week: number): string {
  const url = new URL(value);
  url.searchParams.set("teden", String(week));
  return url.href;
}

function inheritSchoolWeek(value: string, source: string): string {
  const week = new URL(source).searchParams.get("teden");
  if (!week) return value;
  const url = new URL(value);
  url.searchParams.set("teden", week);
  return url.href;
}

function validDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(DATE_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function dateAtNoonUtc(value: string): Date | null {
  const parts = validDateParts(value);
  return parts ? new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)) : null;
}

function currentDateInLjubljana(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Ljubljana",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
