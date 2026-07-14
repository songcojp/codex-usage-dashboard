import type { UsageEventDraft } from "@codex-usage-dashboard/shared";

export type RejectedAcknowledgement = { sourceEventId: string; reason: string };
export type IngestAcknowledgement = {
  inserted: number;
  duplicates: number;
  rejected: RejectedAcknowledgement[];
};
export type ValidatedAcknowledgement = {
  accepted: UsageEventDraft[];
  rejected: Array<{ event: UsageEventDraft; reason: string }>;
};

export function validateAcknowledgement(
  sent: UsageEventDraft[],
  response: unknown
): ValidatedAcknowledgement {
  if (!isAcknowledgement(response)) throw new Error("invalid acknowledgement response");
  if (response.inserted + response.duplicates + response.rejected.length !== sent.length) {
    throw new Error("unaccounted acknowledgement response");
  }

  const eventsById = new Map<string, UsageEventDraft[]>();
  for (const event of sent) {
    const matches = eventsById.get(event.sourceEventId) ?? [];
    matches.push(event);
    eventsById.set(event.sourceEventId, matches);
  }

  const rejectedIds = new Set<string>();
  const rejected: ValidatedAcknowledgement["rejected"] = [];
  for (const entry of response.rejected) {
    const matches = eventsById.get(entry.sourceEventId);
    if (!matches || matches.length !== 1 || rejectedIds.has(entry.sourceEventId)) {
      throw new Error("invalid rejected source event ID in acknowledgement");
    }
    rejectedIds.add(entry.sourceEventId);
    rejected.push({ event: matches[0]!, reason: sanitizeReason(entry.reason) });
  }

  return {
    accepted: sent.filter((event) => !rejectedIds.has(event.sourceEventId)),
    rejected
  };
}

function isAcknowledgement(value: unknown): value is IngestAcknowledgement {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return isCount(candidate.inserted) && isCount(candidate.duplicates) &&
    Array.isArray(candidate.rejected) && candidate.rejected.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as Record<string, unknown>;
      return typeof record.sourceEventId === "string" && record.sourceEventId.length > 0 &&
        typeof record.reason === "string";
    });
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sanitizeReason(reason: string): string {
  const code = reason.trim().toLowerCase().replace(/ +/g, "-");
  return new Set(["invalid", "invalid-model", "invalid-event", "unsupported-tool", "duplicate"]).has(code)
    ? code
    : "server-rejected";
}
