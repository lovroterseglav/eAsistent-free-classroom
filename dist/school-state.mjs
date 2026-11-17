export const FALLBACK_TOKEN = "56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33";
const TOKEN_PATTERN = /^[a-f0-9]{40}$/i;

export function timetableUrlForToken(token) {
  return `https://urniki.easistent.com/urniki/${token.toLowerCase()}`;
}

export function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("sl")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSchool(value) {
  if (!value || typeof value !== "object") return null;
  const token = String(value.token ?? "").trim().toLowerCase();
  const name = String(value.name ?? "").replace(/\s+/g, " ").trim();
  if (!TOKEN_PATTERN.test(token) || !name) return null;
  return { token, name, timetableUrl: timetableUrlForToken(token) };
}

export function mergeSchools(...collections) {
  const merged = new Map();
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const value of collection) {
      const school = normalizeSchool(value);
      if (school && !merged.has(school.token)) merged.set(school.token, school);
    }
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name, "sl", {
    sensitivity: "base",
    numeric: true,
  }));
}

export function filterSchools(schools, query, limit = 50) {
  const normalizedQuery = normalizeSearch(query);
  return schools
    .filter((school) => !normalizedQuery || normalizeSearch(school.name).includes(normalizedQuery))
    .slice(0, limit);
}

export function chooseDefaultSchool(schools, favoriteToken, fallbackToken = FALLBACK_TOKEN) {
  return schools.find((school) => school.token === favoriteToken) ??
    schools.find((school) => school.token === fallbackToken) ??
    schools[0] ?? null;
}

export function tokenFromTimetableUrl(value) {
  try {
    const url = new URL(String(value));
    const match = url.pathname.match(/^\/urniki\/([a-f0-9]{40})(?:\/|$)/i);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
