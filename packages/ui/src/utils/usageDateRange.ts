export type UsageRange = 24 | 168 | 720 | { startDate: string; endDate: string };

function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function usageDateRange(selection: UsageRange, now = new Date()) {
  if (typeof selection !== "number") {
    const { startDate, endDate } = selection;
    return { startDate, endDate,
      start: startDate ? new Date(startDate + "T00:00:00.000").toISOString() : undefined,
      end: endDate ? new Date(endDate + "T23:59:59.999").toISOString() : undefined };
  }
  const start = new Date(now);
  if (selection === 24) {
    start.setTime(now.getTime() - 24 * 60 * 60 * 1000);
  } else {
    start.setDate(start.getDate() - (selection / 24 - 1));
    start.setHours(0, 0, 0, 0);
  }
  return { startDate: localDate(start), endDate: localDate(now),
    start: start.toISOString(), end: now.toISOString() };
}
