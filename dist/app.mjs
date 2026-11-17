import {
  FALLBACK_TOKEN,
  chooseDefaultSchool,
  filterSchools,
  mergeSchools,
  normalizeSchool,
  normalizeSearch,
  tokenFromTimetableUrl,
} from "./school-state.mjs";
import {
  chooseInitialSchedule,
  formatDateValue,
  localClock,
  parseDateValue,
} from "./schedule-state.mjs";

const LEGACY_STORAGE_KEY = "proste-ucilnice.schools.v1";
const FAVORITE_STORAGE_KEY = "proste-ucilnice.favorite-school.v1";
const FALLBACK_SCHOOL = normalizeSchool({ token: FALLBACK_TOKEN, name: "Gimnazija Kranj" });

const elements = {
  schoolDropdown: document.querySelector("#school-dropdown"),
  schoolSummary: document.querySelector("#school-summary"),
  schoolSearch: document.querySelector("#school-search"),
  schoolOptions: document.querySelector("#school-options"),
  favoriteButton: document.querySelector("#favorite-button"),
  date: document.querySelector("#date-input"),
  datePicker: document.querySelector("#date-picker"),
  datePickerButton: document.querySelector("#date-picker-button"),
  periodDropdown: document.querySelector("#period-dropdown"),
  periodSummary: document.querySelector("#period-summary"),
  periodOptions: document.querySelector("#period-options"),
  searchForm: document.querySelector("#search-form"),
  searchButton: document.querySelector("#search-button"),
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
let selectedPeriodNumber = null;
let activeController = null;
let loading = false;

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
  renderSchoolOptions();
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

function setDropdownDisabled(dropdown, disabled) {
  const summary = dropdown.querySelector("summary");
  if (disabled) {
    dropdown.dataset.disabled = "";
    dropdown.open = false;
    summary.setAttribute("aria-disabled", "true");
    summary.tabIndex = -1;
  } else {
    delete dropdown.dataset.disabled;
    summary.removeAttribute("aria-disabled");
    summary.tabIndex = 0;
  }
}

function hasValidSelection() {
  return Boolean(currentSchool && selectedPeriodNumber !== null && validateDateInput());
}

function refreshDisabledState() {
  setDropdownDisabled(elements.schoolDropdown, loading || !schools.length);
  setDropdownDisabled(elements.periodDropdown, loading || !currentSchool?.inspection.periods.length);
  elements.schoolSearch.disabled = loading;
  elements.date.disabled = loading || !currentSchool;
  elements.datePicker.disabled = loading || !currentSchool;
  elements.datePickerButton.disabled = loading || !currentSchool;
  elements.urlInput.disabled = loading;
  elements.addForm.querySelector("button").disabled = loading;
  elements.searchButton.disabled = loading || !hasValidSelection();
  elements.favoriteButton.disabled = loading || !currentSchool;
}

function setLoading(value) {
  loading = value;
  refreshDisabledState();
}

function clearResults() {
  elements.results.hidden = true;
  elements.roomList.replaceChildren();
  elements.unknownList.replaceChildren();
}

function clearScheduleControls() {
  selectedPeriodNumber = null;
  elements.date.value = "";
  elements.date.dataset.min = "";
  elements.date.dataset.max = "";
  elements.date.setCustomValidity("");
  elements.datePicker.value = "";
  elements.datePicker.removeAttribute("min");
  elements.datePicker.removeAttribute("max");
  elements.periodSummary.textContent = "Nalaganje …";
  elements.periodOptions.replaceChildren();
}

function fillControls(inspection) {
  elements.date.dataset.min = inspection.schoolYear.start;
  elements.date.dataset.max = inspection.schoolYear.end;
  elements.datePicker.min = inspection.schoolYear.start;
  elements.datePicker.max = inspection.schoolYear.end;
  const initial = chooseInitialSchedule(inspection.dates, inspection.periods, localClock());
  elements.date.value = formatDateValue(initial.date);
  elements.datePicker.value = initial.date;
  selectedPeriodNumber = initial.periodNumber;
  renderPeriodOptions();
  refreshDisabledState();
}

function validateDateInput() {
  elements.date.setCustomValidity("");
  const date = parseDateValue(elements.date.value);
  if (!date) {
    elements.date.setCustomValidity("Vnesi veljaven datum v obliki DD/MM/YYYY.");
    return null;
  }
  if (date < elements.date.dataset.min || date > elements.date.dataset.max) {
    elements.date.setCustomValidity("Datum ni v trenutnem šolskem letu.");
    return null;
  }
  elements.datePicker.value = date;
  return date;
}

function updateSelectedSchool() {
  elements.schoolSummary.textContent = selectedSchool?.name ?? "Izberi šolo";
  updateFavoriteButton();
  renderSchoolOptions();
}

function updateFavoriteButton() {
  const starred = Boolean(selectedSchool?.token && favoriteToken() === selectedSchool.token);
  elements.favoriteButton.textContent = starred ? "★" : "☆";
  elements.favoriteButton.setAttribute("aria-pressed", String(starred));
  const label = starred ? "Odstrani privzeto šolo" : "Nastavi kot privzeto šolo";
  elements.favoriteButton.setAttribute("aria-label", label);
  elements.favoriteButton.title = label;
}

function duplicateNameCounts() {
  const counts = new Map();
  for (const school of schools) {
    const key = normalizeSearch(school.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function renderSchoolOptions() {
  const visibleSchools = filterSchools(schools, elements.schoolSearch.value, 50, selectedSchool?.token);
  const nameCounts = duplicateNameCounts();
  elements.schoolOptions.replaceChildren();
  if (!visibleSchools.length) {
    const empty = document.createElement("p");
    empty.className = "school-empty";
    empty.textContent = "Ni najdenih šol. Dodaj povezavo spodaj.";
    elements.schoolOptions.append(empty);
    return;
  }
  for (const school of visibleSchools) {
    const option = document.createElement("label");
    option.className = "choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "school-choice";
    radio.value = school.token;
    radio.checked = selectedSchool?.token === school.token;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      elements.schoolDropdown.open = false;
      elements.schoolDropdown.querySelector("summary").focus();
      loadSchool(school);
    });
    const name = document.createElement("span");
    name.textContent = school.name;
    option.append(radio, name);
    if ((nameCounts.get(normalizeSearch(school.name)) ?? 0) > 1) {
      const suffix = document.createElement("small");
      suffix.textContent = school.token.slice(0, 6);
      option.append(suffix);
    }
    elements.schoolOptions.append(option);
  }
}

function renderPeriodOptions() {
  elements.periodOptions.replaceChildren();
  const periods = currentSchool?.inspection.periods ?? [];
  for (const period of periods) {
    const option = document.createElement("label");
    option.className = "choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "period-choice";
    radio.value = String(period.number);
    radio.checked = selectedPeriodNumber === period.number;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      selectedPeriodNumber = period.number;
      updatePeriodSummary();
      elements.periodDropdown.open = false;
      elements.periodDropdown.querySelector("summary").focus();
      refreshDisabledState();
    });
    const label = document.createElement("span");
    label.textContent = `${period.label} · ${formatMinute(period.startMinute)}–${formatMinute(period.endMinute)}`;
    option.append(radio, label);
    elements.periodOptions.append(option);
  }
  updatePeriodSummary();
}

function updatePeriodSummary() {
  const period = currentSchool?.inspection.periods.find((item) => item.number === selectedPeriodNumber);
  elements.periodSummary.textContent = period
    ? `${period.label} · ${formatMinute(period.startMinute)}–${formatMinute(period.endMinute)}`
    : "Izberi šolsko uro";
}

async function loadSchool(entry, { added = false } = {}) {
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  selectedSchool = normalizeSchool(entry);
  currentSchool = null;
  clearScheduleControls();
  updateSelectedSchool();
  clearResults();
  setLoading(true);
  setStatus("Nalaganje urnika …");
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
  const requestedDate = validateDateInput();
  if (!currentSchool || selectedPeriodNumber === null || !requestedDate) return;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  setLoading(true);
  clearResults();
  setStatus("Preverjanje učilnic …");
  try {
    const result = await apiRequest("/api/v1/availability", {
      timetableUrl: currentSchool.entry.timetableUrl,
      date: requestedDate,
      period: selectedPeriodNumber,
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

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("sl-SI", { weekday: "long", day: "numeric", month: "long" }).format(date);
}

function formatMinute(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

for (const dropdown of [elements.schoolDropdown, elements.periodDropdown]) {
  const summary = dropdown.querySelector("summary");
  summary.addEventListener("click", (event) => {
    if (dropdown.hasAttribute("data-disabled")) event.preventDefault();
  });
  dropdown.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dropdown.open) {
      event.preventDefault();
      dropdown.open = false;
      summary.focus();
    }
  });
}

elements.schoolDropdown.addEventListener("toggle", () => {
  if (!elements.schoolDropdown.open) return;
  elements.periodDropdown.open = false;
  elements.schoolSearch.value = "";
  renderSchoolOptions();
  requestAnimationFrame(() => elements.schoolSearch.focus());
});
elements.schoolSearch.addEventListener("input", renderSchoolOptions);
elements.periodDropdown.addEventListener("toggle", () => {
  if (elements.periodDropdown.open) elements.schoolDropdown.open = false;
});
document.addEventListener("click", (event) => {
  for (const dropdown of [elements.schoolDropdown, elements.periodDropdown]) {
    if (dropdown.open && !dropdown.contains(event.target)) dropdown.open = false;
  }
});
elements.favoriteButton.addEventListener("click", () => {
  if (!currentSchool?.entry?.token) return;
  setFavoriteToken(favoriteToken() === currentSchool.entry.token ? null : currentSchool.entry.token);
});
elements.date.addEventListener("input", refreshDisabledState);
elements.date.addEventListener("blur", () => {
  const date = validateDateInput();
  if (date) elements.date.value = formatDateValue(date);
});
elements.datePicker.addEventListener("change", () => {
  elements.date.value = formatDateValue(elements.datePicker.value);
  validateDateInput();
  refreshDisabledState();
});
elements.datePickerButton.addEventListener("click", () => {
  if (typeof elements.datePicker.showPicker === "function") elements.datePicker.showPicker();
  else elements.datePicker.click();
});
elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  validateDateInput();
  if (!elements.date.reportValidity()) return;
  searchRooms();
});
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
