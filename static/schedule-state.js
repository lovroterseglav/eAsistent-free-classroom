export function chooseInitialSchedule(dates, periods, clock) {
  const date = dates.includes(clock.date) ? clock.date : dates[0] ?? "";
  const activePeriod = periods.find((period) =>
    clock.minute >= period.startMinute && clock.minute < period.endMinute);
  return {
    date,
    periodNumber: activePeriod?.number ?? periods[0]?.number ?? null,
  };
}

export function localClock(now = new Date()) {
  return {
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    minute: now.getHours() * 60 + now.getMinutes(),
  };
}

export function formatDateValue(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))) return "";
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export function parseDateValue(value) {
  const match = String(value).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  if (!isRealDate(Number(year), Number(month), Number(day))) return null;
  return `${year}-${month}-${day}`;
}

function isRealDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
