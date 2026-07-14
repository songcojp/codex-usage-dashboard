export function normalizeTimestampUtc(value: string, fieldName: string): string {
  const normalized = value.trim().replace(" ", "T");
  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid timestamp`);
  }

  return date.toISOString();
}
