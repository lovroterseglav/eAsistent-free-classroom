import * as cheerio from "cheerio";
import type { CheerioAPI, Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";
import type { Classroom, Period, RoomState } from "./types.js";

const PERIOD_ID = /^urnik-ura-(-?\d+)$/;
const CELL_ID = /^ednevnik-seznam_ur_teden-td-(-?\d+)-(\d{4}-\d{2}-\d{2})$/;
const SCHOOL_TOKEN = /^[a-f0-9]{40}$/i;
const AJAX_PATH = /\/urniki\/ajax_urnik\/([a-f0-9]{40})\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/i;

export function normalizeSpace(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function parsePeriodRange(value: string): Pick<Period, "startMinute" | "endMinute"> | null {
  const match = normalizeSpace(value).match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const startMinute = Number(match[1]) * 60 + Number(match[2]);
  const endMinute = Number(match[3]) * 60 + Number(match[4]);
  if (startMinute < 0 || endMinute <= startMinute || endMinute > 24 * 60) return null;
  return { startMinute, endMinute };
}

export function parseScheduleMetadata(html: string): { schoolName: string; dates: string[]; periods: Period[] } {
  const $ = cheerio.load(html);
  const schoolName = normalizeSpace($(".urnik_title").first().text());
  const periods: Period[] = [];
  $('th[id^="urnik-ura-"]').each((_index, element) => {
    const match = ($(element).attr("id") ?? "").match(PERIOD_ID);
    const range = parsePeriodRange($(element).find(".potek-ure").first().text());
    if (!match || !range) return;
    const number = Number(match[1]);
    periods.push({ number, label: `${number}. ura`, ...range });
  });
  periods.sort((left, right) => left.number - right.number);

  const dates = new Set<string>();
  $('td[id^="ednevnik-seznam_ur_teden-td-"]').each((_index, element) => {
    const match = ($(element).attr("id") ?? "").match(CELL_ID);
    if (match?.[2]) dates.add(match[2]);
  });
  return { schoolName, dates: [...dates].sort(), periods };
}

export function ajaxTimetableUrl(html: string, sourceUrl: string, week: number): string | null {
  if (!Number.isInteger(week) || week < 1 || week > 60) return null;
  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return null;
  }
  const sourceSegments = source.pathname.split("/").filter(Boolean);
  const sourceToken = sourceSegments[0] === "urniki" && SCHOOL_TOKEN.test(sourceSegments[1] ?? "")
    ? sourceSegments[1]!.toLowerCase()
    : null;
  if (!sourceToken || source.protocol !== "https:" || !["urniki.easistent.com", "www.easistent.com"].includes(source.hostname)) {
    return null;
  }

  const unescaped = html.replaceAll("\\/", "/");
  const path = unescaped.match(AJAX_PATH);
  if (path) {
    if (path[1]?.toLowerCase() !== sourceToken) return null;
    return buildAjaxUrl(source, sourceToken, path.slice(2, 6), week, path[7], path[8]);
  }

  const values = {
    classId: scriptNumber(unescaped, "id_razred"),
    teacherId: scriptNumber(unescaped, "id_profesor"),
    studentId: scriptNumber(unescaped, "id_dijak"),
    classroomId: scriptNumber(unescaped, "id_ucilnica"),
    activityId: scriptNumber(unescaped, "id_interesna_dejavnost"),
    queryVersion: scriptNumber(unescaped, "qversion") ?? "1",
  };
  const entity = sourceSegments[2];
  if (entity === "razredi" && !values.classId) return null;
  if (entity === "ucilnice" && sourceSegments[3] && !values.classroomId) return null;
  if (![values.classId, values.teacherId, values.studentId, values.classroomId].some((value) => value && value !== "0")) return null;
  return buildAjaxUrl(source, sourceToken, [
    values.classId ?? "0",
    values.teacherId ?? "0",
    values.studentId ?? "0",
    values.classroomId ?? "0",
  ], week, values.activityId ?? "0", values.queryVersion);
}

function scriptNumber(html: string, name: string): string | null {
  const match = html.match(new RegExp(`(?:var\\s+)?${name}\\s*=\\s*['\"]?(\\d+)['\"]?`, "i"));
  return match?.[1] ?? null;
}

function buildAjaxUrl(
  source: URL,
  token: string,
  entityIds: Array<string | undefined>,
  week: number,
  activityId: string | undefined,
  queryVersion: string | undefined,
): string | null {
  const segments = [...entityIds, String(week), activityId, queryVersion];
  if (entityIds.length !== 4 || segments.some((value) => !/^\d+$/.test(value ?? ""))) return null;
  return `${source.origin}/urniki/ajax_urnik/${token}/${segments.join("/")}`;
}

export function classroomIndexCandidates(html: string, sourceUrl: string, schoolRoot: string): string[] {
  const $ = cheerio.load(html);
  const found = new Set<string>();
  $("a[href], option[value], form[action]").each((_index, element) => {
    const item = $(element);
    const raw = item.attr("href") ?? item.attr("value") ?? item.attr("action");
    if (!raw) return;
    try {
      const candidate = new URL(raw, sourceUrl);
      if (candidate.pathname.includes("/ucilnice")) found.add(candidate.href);
    } catch {
      // Ignore malformed upstream navigation values.
    }
  });
  found.add(`${schoolRoot}/ucilnice`);
  return [...found];
}

export function parseClassrooms(html: string, sourceUrl: string): Classroom[] {
  const source = new URL(sourceUrl);
  const pathMatch = source.pathname.match(/^(.*\/ucilnice)(?:\/\d+)?\/?$/);
  if (!pathMatch?.[1]) return [];
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const classrooms: Classroom[] = [];
  $("#id_parameter option").each((_index, element) => {
    const option = $(element);
    const id = option.attr("value")?.trim() ?? "";
    const name = normalizeSpace(option.text());
    if (!id || !name) return;
    let url: string;
    if (/^\d+$/.test(id)) {
      url = `${source.origin}${pathMatch[1]}/${id}`;
    } else {
      try {
        url = new URL(id, sourceUrl).href;
      } catch {
        return;
      }
      if (!new URL(url).pathname.includes("/ucilnice/")) return;
    }
    if (seen.has(url)) return;
    seen.add(url);
    classrooms.push({ id, name, url });
  });
  return classrooms;
}

function blockIsCancelled($: CheerioAPI, block: Cheerio<AnyNode>): boolean {
  const classText = block.attr("class") ?? "";
  const tags: string[] = [];
  block.find(".wl-tag-xs").each((_index, tag) => {
    tags.push($(tag).attr("title") ?? "", $(tag).text());
  });
  const value = normalizeSpace(`${classText} ${tags.join(" ")}`).toLocaleLowerCase("sl");
  return value.includes("odpadla-ura") || value.includes("odpadla ura") ||
    value.includes("neopravljena-ura") || value.includes("neopravljena ura");
}

export function roomAvailability(html: string, date: string, periodNumber: number): RoomState {
  const $ = cheerio.load(html);
  const cell = $(`[id="ednevnik-seznam_ur_teden-td-${periodNumber}-${date}"]`).first();
  if (!cell.length) return "unknown";
  const blocks = cell.find(".ednevnik-seznam_ur_teden-blok-wrap").toArray();
  if (!blocks.length) return "free";
  return blocks.every((block) => blockIsCancelled($, $(block))) ? "free" : "occupied";
}

export function naturalRoomSort(left: Pick<Classroom, "name">, right: Pick<Classroom, "name">): number {
  return left.name.localeCompare(right.name, "sl", { numeric: true, sensitivity: "base" });
}
