import {
  FALLBACK_TOKEN,
  chooseDefaultSchool,
  filterSchools,
  mergeSchools,
  normalizeSchool,
  normalizeSearch,
  timetableUrlForToken,
  tokenFromTimetableUrl,
} from "./school-state.mjs";

const LEGACY_STORAGE_KEY = "proste-ucilnice.schools.v1";
const FAVORITE_STORAGE_KEY = "proste-ucilnice.favorite-school.v1";
const FALLBACK_SCHOOL = normalizeSchool({ token: FALLBACK_TOKEN, name: "Gimnazija Kranj" });

const elements = {
  schoolSearch: document.querySelector("#school-search"),
  schoolToggle: document.querySelector("#school-toggle"),
  schoolOptions: document.querySelector("#school-options"),
  favoriteButton: document.querySelector("#favorite-button"),
  date: document.querySelector("#date-select"),
  period: document.querySelector("#period-select"),
  searchForm: document.querySelector("#search-form"),
  searchButton: document.querySelector("#search-button"),
  nowButton: document.querySelector("#now-button"),
  addForm: document.querySelector("#add-school-form"),
  urlInput: document.querySelector("#school-url"),
  status: document.querySelector("#status"),
  results: document.querySelector("#results-section"),
  resultMeta: document.querySelector("#result-meta"),
  freeSummary: document.querySelector("#free-summary"),
  roomList: document.querySelector("#room-list"),
  unknownSection: document.querySelector("#unknown-section"),
  unknownSummary: document.querySelector("#unknown-summary"),
  unknownList: document.querySelector("#unknown-list"),
  sourceLink: document.querySelector("#source-link"),
};

let schools = [];
let selectedSchool = null;
let currentSchool = null;
let activeController = null;
let visibleSchools = [];
let activeOption = -1;
let schoolListOpen = false;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function readLegacySchools() {
  try {
    const stored = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.map((item) => normalizeSchool({
      token: /^[a-f0-9]{40}$/i.test(item?.id ?? "") ? item.id : tokenFromTimetableUrl(item?.url),
      name: item?.name,
    })).filter(Boolean);
  } catch {
    return [];
  }
}

function removeLegacySchool(token) {
  try {
    const stored = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return;
    const remaining = stored.filter((item) => {
      const itemToken = /^[a-f0-9]{40}$/i.test(item?.id ?? "") ? item.id.toLowerCase() : tokenFromTimetableUrl(item?.url);
      return itemToken !== token;
    });
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(remaining));
  } catch {
    // Invalid legacy data is ignored.
  }
}

function favoriteToken() {
  try {
    return localStorage.getItem(FAVORITE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setFavoriteToken(token) {
  try {
    if (token) localStorage.setItem(FAVORITE_STORAGE_KEY, token);
    else localStorage.removeItem(FAVORITE_STORAGE_KEY);
  } catch {
    // The selection still works when browser storage is unavailable.
  }
  updateFavoriteButton();
}

async function apiGet(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error?.code, data?.error?.message ?? `API je vrnil HTTP ${response.status}.`);
  return data;
}

async function apiRequest(path, body, signal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error?.code, data?.error?.message ?? `API je vrnil HTTP ${response.status}.`);
  return data;
}

function setStatus(message, kind = "info") {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

function setLoading(loading) {
  elements.schoolSearch.disabled = loading;
  elements.schoolToggle.disabled = loading;
  elements.urlInput.disabled = loading;
  elements.addForm.querySelector("button").disabled = loading;
  elements.searchButton.disabled = loading || !currentSchool;
  elements.favoriteButton.disabled = loading || !currentSchool;
}

function clearResults() {
  elements.results.hidden = true;
  elements.roomList.replaceChildren();
  elements.unknownList.replaceChildren();
}

function fillControls(inspection) {
  elements.date.replaceChildren();
  for (const date of inspection.dates) {
    const option = document.createElement("option");
    option.value = date;
    option.textContent = formatDate(date);
    elements.date.append(option);
  }
  elements.period.replaceChildren();
  for (const period of inspection.periods) {
    const option = document.createElement("option");
    option.value = String(period.number);
    option.textContent = `${period.label} · ${formatMinute(period.startMinute)}–${formatMinute(period.endMinute)}`;
    elements.period.append(option);
  }
  elements.date.disabled = !inspection.dates.length;
  elements.period.disabled = !inspection.periods.length;
}

function updateSelectedSchool() {
  elements.schoolSearch.value = selectedSchool?.name ?? "";
  updateFavoriteButton();
}

function updateFavoriteButton() {
  const starred = Boolean(selectedSchool?.token && favoriteToken() === selectedSchool.token);
  elements.favoriteButton.textContent = starred ? "★" : "☆";
  elements.favoriteButton.setAttribute("aria-pressed", String(starred));
  const label = starred ? "Odstrani privzeto šolo" : "Nastavi kot privzeto šolo";
  elements.favoriteButton.setAttribute("aria-label", label);
  elements.favoriteButton.title = label;
}

function openSchoolList({ showAll = false } = {}) {
  if (elements.schoolSearch.disabled) return;
  if (showAll) elements.schoolSearch.value = "";
  schoolListOpen = true;
  elements.schoolSearch.setAttribute("aria-expanded", "true");
  elements.schoolOptions.hidden = false;
  renderSchoolOptions();
}

function closeSchoolList({ restore = true } = {}) {
  schoolListOpen = false;
  activeOption = -1;
  elements.schoolSearch.setAttribute("aria-expanded", "false");
  elements.schoolSearch.removeAttribute("aria-activedescendant");
  elements.schoolOptions.hidden = true;
  if (restore) updateSelectedSchool();
}

function renderSchoolOptions() {
  if (!schoolListOpen) return;
  visibleSchools = filterSchools(schools, elements.schoolSearch.value);
  elements.schoolOptions.replaceChildren();
  const nameCounts = new Map();
  for (const school of schools) {
    const key = normalizeSearch(school.name);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  if (!visibleSchools.length) {
    const empty = document.createElement("p");
    empty.className = "school-empty";
    empty.textContent = "Ni najdenih šol. Dodaj povezavo spodaj.";
    elements.schoolOptions.append(empty);
    activeOption = -1;
    return;
  }
  if (activeOption >= visibleSchools.length) activeOption = visibleSchools.length - 1;
  for (const [index, school] of visibleSchools.entries()) {
    const option = document.createElement("button");
    option.type = "button";
    option.id = `school-option-${index}`;
    option.className = "school-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(selectedSchool?.token === school.token));
    option.tabIndex = -1;
    option.append(document.createTextNode(school.name));
    if ((nameCounts.get(normalizeSearch(school.name)) ?? 0) > 1) {
      const suffix = document.createElement("small");
      suffix.textContent = school.token.slice(0, 6);
      option.append(suffix);
    }
    option.addEventListener("mouseenter", () => setActiveOption(index));
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => selectSchool(school));
    elements.schoolOptions.append(option);
  }
  applyActiveOption();
}

function setActiveOption(index) {
  activeOption = index;
  applyActiveOption();
}

function applyActiveOption() {
  const options = [...elements.schoolOptions.querySelectorAll(".school-option")];
  for (const [index, option] of options.entries()) option.classList.toggle("active", index === activeOption);
  if (activeOption >= 0 && options[activeOption]) {
    elements.schoolSearch.setAttribute("aria-activedescendant", options[activeOption].id);
    options[activeOption].scrollIntoView({ block: "nearest" });
  } else {
    elements.schoolSearch.removeAttribute("aria-activedescendant");
  }
}

function moveActiveOption(direction) {
  if (!schoolListOpen) openSchoolList();
  if (!visibleSchools.length) return;
  const next = activeOption < 0 ? (direction > 0 ? 0 : visibleSchools.length - 1) :
    (activeOption + direction + visibleSchools.length) % visibleSchools.length;
  setActiveOption(next);
}

function selectSchool(school) {
  closeSchoolList({ restore: false });
  loadSchool(school);
}

async function loadSchool(entry, { added = false } = {}) {
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  selectedSchool = normalizeSchool(entry);
  currentSchool = null;
  updateSelectedSchool();
  clearResults();
  setLoading(true);
  setStatus("Nalaganje urnika …");
  elements.date.disabled = true;
  elements.period.disabled = true;
  let fallback = null;
  try {
    const inspection = await apiRequest("/api/v1/schools/inspect", { timetableUrl: entry.timetableUrl }, controller.signal);
    const resolved = normalizeSchool({ token: inspection.school.token, name: inspection.school.name });
    schools = mergeSchools(schools, resolved ? [resolved] : []);
    selectedSchool = schools.find((school) => school.token === resolved?.token) ?? resolved;
    currentSchool = { entry: selectedSchool, inspection };
    updateSelectedSchool();
    fillControls(inspection);
    elements.sourceLink.href = inspection.school.canonicalUrl;
    setStatus(`${inspection.school.name} · ${inspection.classroomCount} učilnic`, "success");
    if (added) {
      elements.urlInput.value = "";
      elements.addForm.closest("details").open = false;
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus(error.message || "Urnika ni bilo mogoče naložiti.", "error");
    if (error.code === "TIMETABLE_NOT_FOUND" && selectedSchool?.token) {
      const missingToken = selectedSchool.token;
      schools = schools.filter((school) => school.token !== missingToken);
      removeLegacySchool(missingToken);
      if (favoriteToken() === missingToken) setFavoriteToken(null);
      selectedSchool = null;
      fallback = chooseDefaultSchool(schools, favoriteToken());
    }
  } finally {
    if (activeController === controller) {
      activeController = null;
      setLoading(false);
      updateSelectedSchool();
    }
  }
  if (fallback) loadSchool(fallback);
}

async function searchRooms() {
  if (!currentSchool) return;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  setLoading(true);
  clearResults();
  setStatus("Preverjanje učilnic …");
  try {
    const result = await apiRequest("/api/v1/availability", {
      timetableUrl: currentSchool.entry.timetableUrl,
      date: elements.date.value,
      period: Number(elements.period.value),
    }, controller.signal);
    renderResults(result);
    setStatus(`Preverjeno ob ${new Intl.DateTimeFormat("sl-SI", { hour: "2-digit", minute: "2-digit" }).format(new Date(result.fetchedAt))}`, "success");
  } catch (error) {
    if (error.name !== "AbortError") setStatus(error.message || "Učilnic ni bilo mogoče preveriti.", "error");
  } finally {
    if (activeController === controller) {
      activeController = null;
      setLoading(false);
    }
  }
}

function renderResults(result) {
  elements.results.hidden = false;
  elements.roomList.replaceChildren();
  elements.unknownList.replaceChildren();
  elements.resultMeta.textContent = `${formatDate(result.date)} · ${result.period.label}, ${formatMinute(result.period.startMinute)}–${formatMinute(result.period.endMinute)}`;

  const count = document.createElement("strong");
  count.textContent = String(result.rooms.free.length);
  const label = document.createElement("span");
  label.textContent = result.rooms.free.length === 1 ? "prosta učilnica" : "prostih učilnic";
  elements.freeSummary.replaceChildren(count, label);

  for (const room of result.rooms.free) {
    const card = document.createElement("div");
    card.className = "room-card";
    const dot = document.createElement("span");
    dot.className = "availability-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("strong");
    name.textContent = room.name;
    card.append(dot, name);
    elements.roomList.append(card);
  }
  if (!result.rooms.free.length) {
    const empty = document.createElement("p");
    empty.className = "empty-result";
    empty.textContent = "Za izbrani termin ni potrjeno proste učilnice.";
    elements.roomList.append(empty);
  }

  elements.unknownSection.hidden = !result.rooms.unknown.length;
  elements.unknownSummary.textContent = `Ni bilo mogoče preveriti (${result.rooms.unknown.length})`;
  for (const room of result.rooms.unknown) {
    const item = document.createElement("li");
    item.textContent = room.name;
    elements.unknownList.append(item);
  }
}

function useCurrentTime() {
  if (!currentSchool) return;
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const minute = now.getHours() * 60 + now.getMinutes();
  const period = currentSchool.inspection.periods.find((item) => minute >= item.startMinute && minute < item.endMinute);
  if (!currentSchool.inspection.dates.includes(date) || !period) {
    setStatus("Trenutni čas ni del prikazanega urnika.", "error");
    return;
  }
  elements.date.value = date;
  elements.period.value = String(period.number);
  searchRooms();
}

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("sl-SI", { weekday: "long", day: "numeric", month: "long" }).format(date);
}

function formatMinute(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

elements.schoolSearch.addEventListener("focus", () => openSchoolList());
elements.schoolSearch.addEventListener("input", () => {
  activeOption = 0;
  openSchoolList();
});
elements.schoolSearch.addEventListener("blur", () => setTimeout(() => closeSchoolList(), 0));
elements.schoolSearch.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveActiveOption(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter" && schoolListOpen && activeOption >= 0) {
    event.preventDefault();
    selectSchool(visibleSchools[activeOption]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSchoolList();
  }
});
elements.schoolToggle.addEventListener("mousedown", (event) => event.preventDefault());
elements.schoolToggle.addEventListener("click", () => {
  if (schoolListOpen) closeSchoolList();
  else {
    openSchoolList({ showAll: true });
    elements.schoolSearch.focus();
  }
});
elements.favoriteButton.addEventListener("click", () => {
  if (!currentSchool?.entry?.token) return;
  setFavoriteToken(favoriteToken() === currentSchool.entry.token ? null : currentSchool.entry.token);
});
elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  searchRooms();
});
elements.nowButton.addEventListener("click", useCurrentTime);
elements.addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadSchool({ timetableUrl: elements.urlInput.value }, { added: true });
});

async function initialize() {
  setLoading(true);
  setStatus("Nalaganje šol …");
  const legacySchools = readLegacySchools();
  try {
    const catalog = await apiGet("/api/v1/schools");
    schools = mergeSchools(catalog.schools, legacySchools);
  } catch {
    schools = mergeSchools(FALLBACK_SCHOOL ? [FALLBACK_SCHOOL] : [], legacySchools);
    setStatus("Seznama šol ni bilo mogoče naložiti.", "error");
  } finally {
    setLoading(false);
  }

  const storedFavorite = favoriteToken();
  const initialSchool = chooseDefaultSchool(schools, storedFavorite);
  if (storedFavorite && initialSchool?.token !== storedFavorite) setFavoriteToken(null);
  if (initialSchool) loadSchool(initialSchool);
  else {
    selectedSchool = null;
    updateSelectedSchool();
    setStatus("Dodaj povezavo do javnega urnika šole.");
  }
}

initialize();
