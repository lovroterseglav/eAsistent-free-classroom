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
