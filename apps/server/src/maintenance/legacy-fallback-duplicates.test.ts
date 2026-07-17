import { describe, expect, it, vi } from "vitest";

import {
  auditLegacyFallbackDuplicates,
  cleanupLegacyFallbackDuplicates,
  type LegacyFallbackDuplicateAudit,
  type LegacyFallbackDuplicateStore
} from "./legacy-fallback-duplicates.js";

const deviceId = "56881519-f053-42ea-8602-2e1981da148c";
const audit: LegacyFallbackDuplicateAudit = {
  deviceId,
  deviceName: "john-linux-workstation",
  fallbackRows: 6_190,
  fallbackTokens: 554_969_313,
  matchedRows: 6_190,
  matchedTokens: 554_969_313,
  ambiguousGroups: 0,
  safeToClean: true
};

describe("legacy fallback duplicate maintenance", () => {
  it("audits one device without mutating data", async () => {
    const store = storeWithAudit(audit);

    await expect(auditLegacyFallbackDuplicates({ deviceId, store })).resolves.toEqual(audit);
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it("refuses cleanup without explicit confirmation", async () => {
    const store = storeWithAudit(audit);

    await expect(
      cleanupLegacyFallbackDuplicates({ deviceId, confirm: false, store })
    ).rejects.toThrow("legacy fallback duplicate cleanup requires explicit confirmation");
    expect(store.audit).not.toHaveBeenCalled();
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it("refuses cleanup when fallback rows are not one-to-one matched", async () => {
    const unsafeAudit = {
      ...audit,
      matchedRows: 6_189,
      matchedTokens: 554_946_365,
      ambiguousGroups: 1,
      safeToClean: false
    };
    const store = storeWithAudit(unsafeAudit);

    await expect(
      cleanupLegacyFallbackDuplicates({ deviceId, confirm: true, store })
    ).rejects.toThrow("not all legacy fallback rows have one-to-one canonical partners");
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it("does nothing when the device has no legacy fallback rows", async () => {
    const emptyAudit = {
      ...audit,
      fallbackRows: 0,
      fallbackTokens: 0,
      matchedRows: 0,
      matchedTokens: 0,
      safeToClean: true
    };
    const store = storeWithAudit(emptyAudit);

    await expect(
      cleanupLegacyFallbackDuplicates({ deviceId, confirm: true, store })
    ).resolves.toEqual({
      ...emptyAudit,
      executed: false,
      batchId: null,
      backedUp: 0,
      deleted: 0,
      deletedTokens: 0,
      rollupsRebuilt: 0
    });
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it("backs up and deletes the fully matched fallback cohort", async () => {
    const store = storeWithAudit(audit);
    vi.mocked(store.cleanup).mockResolvedValue({
      batchId: "00000000-0000-4000-8000-000000000099",
      backedUp: 6_190,
      deleted: 6_190,
      deletedTokens: 554_969_313,
      rollupsRebuilt: 475
    });

    await expect(
      cleanupLegacyFallbackDuplicates({ deviceId, confirm: true, store })
    ).resolves.toEqual({
      ...audit,
      executed: true,
      batchId: "00000000-0000-4000-8000-000000000099",
      backedUp: 6_190,
      deleted: 6_190,
      deletedTokens: 554_969_313,
      rollupsRebuilt: 475
    });
    expect(store.cleanup).toHaveBeenCalledWith({
      expectedRows: 6_190,
      expectedTokens: 554_969_313
    });
  });

  it("rejects a cleanup result that differs from the audited cohort", async () => {
    const store = storeWithAudit(audit);
    vi.mocked(store.cleanup).mockResolvedValue({
      batchId: "00000000-0000-4000-8000-000000000099",
      backedUp: 6_189,
      deleted: 6_189,
      deletedTokens: 554_946_365,
      rollupsRebuilt: 475
    });

    await expect(
      cleanupLegacyFallbackDuplicates({ deviceId, confirm: true, store })
    ).rejects.toThrow("legacy fallback duplicate cleanup count mismatch");
  });
});

function storeWithAudit(value: LegacyFallbackDuplicateAudit): LegacyFallbackDuplicateStore {
  return {
    audit: vi.fn().mockResolvedValue(value),
    cleanup: vi.fn()
  };
}
