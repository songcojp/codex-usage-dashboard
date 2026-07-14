const blockedTerms = [
  "prompt",
  "prompts",
  "response",
  "responses",
  "completion",
  "completions",
  "message",
  "messages",
  "conversation",
  "transcript"
];

const unixAbsolutePathPattern = /\/[^/\s]+(?:\/[^/\s]+)+/;
const fileUriPathPattern = /file:\/\/\/[^/\s]+(?:\/[^/\s]+)+/i;
const windowsAbsolutePathPattern = /[a-z]:\\[^\\\s]+(?:\\[^\\\s]+)+/i;

export function assertSanitizedMetadata(metadata: Record<string, unknown>): void {
  inspectMetadataValue(metadata);
}

function inspectMetadataValue(value: unknown, keyPath = "metadata"): void {
  if (typeof value === "string" && containsFullLocalPath(value)) {
    throw new Error(`metadata contains full local path in key: ${keyPath}`);
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectMetadataValue(item, `${keyPath}[${index}]`));
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (isBlockedContentKey(key)) {
      throw new Error(`metadata contains blocked content key: ${keyPath}.${key}`);
    }

    inspectMetadataValue(nestedValue, `${keyPath}.${key}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBlockedContentKey(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return blockedTerms.some((term) => normalizedKey.includes(term));
}

function containsFullLocalPath(value: string): boolean {
  return (
    unixAbsolutePathPattern.test(value) ||
    fileUriPathPattern.test(value) ||
    windowsAbsolutePathPattern.test(value)
  );
}
