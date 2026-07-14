export const defaultReportingTimeZone = "Asia/Tokyo";
export const supportedReportingTimeZones = [
  "Asia/Tokyo",
  "UTC",
  "Asia/Shanghai",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles"
] as const;

export type ReportingTimeZone = (typeof supportedReportingTimeZones)[number];

export function isSupportedReportingTimeZone(value: string): value is ReportingTimeZone {
  return supportedReportingTimeZones.includes(value as ReportingTimeZone);
}

export function reportingDayFromTimestamp(
  timestamp: string | Date,
  timeZone: ReportingTimeZone = defaultReportingTimeZone
): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const parts = datePartsInTimeZone(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function reportingDayUtcRange(
  day: string,
  timeZone: ReportingTimeZone = defaultReportingTimeZone
): { start: Date; end: Date } {
  const [year, month, date] = day.split("-").map(Number);
  const startMs = utcMsForTimeZoneMidnight(year, month, date, timeZone);
  const endMs = utcMsForTimeZoneMidnight(year, month, date + 1, timeZone) - 1;

  return {
    start: new Date(startMs),
    end: new Date(endMs)
  };
}

function utcMsForTimeZoneMidnight(
  year: number,
  month: number,
  day: number,
  timeZone: ReportingTimeZone
): number {
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  let utcMs = localMidnightAsUtc - timeZoneOffsetMs(new Date(localMidnightAsUtc), timeZone);
  utcMs = localMidnightAsUtc - timeZoneOffsetMs(new Date(utcMs), timeZone);
  return utcMs;
}

function timeZoneOffsetMs(date: Date, timeZone: ReportingTimeZone): number {
  const parts = datePartsInTimeZone(date, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return localAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function datePartsInTimeZone(date: Date, timeZone: ReportingTimeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  const hour = values.hour === "24" ? 0 : Number(values.hour);
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour,
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
