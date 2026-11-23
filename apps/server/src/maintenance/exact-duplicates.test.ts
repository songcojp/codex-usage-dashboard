import { describe, expect, it, vi } from "vitest";

import {
  auditExactUsageDuplicates,
  cleanupExactUsageDuplicates,
  type ExactDuplicateAudit,
  type ExactDuplicateStore
} from "./exact-duplicates.js";

const audit: ExactDuplicateAudit = {
  broadGroups: 3,
  broadExcessRows: 4,
  strictGroups: 1,
  strictExcessRows: 2,
  strictExcessTokens: 320
};

describe("exact usage duplicate maintenance", () => {
  it("reports broad and strict duplicate counts without mutating data", async () => {
    const store = storeWithAudit(audit);

    await expect(auditExactUsageDuplicates({ store })).resolves.toEqual(audit);
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it("refuses cleanup without explicit confirmation", async () => {
    const store = storeWithAudit(audit);

    await expect(cleanupExactUsageDuplicates({ store, confirm: false })).rejects.toThrow(
      "exact duplicate cleanup requires explicit confirmation"
    );
    expect(store.audit).not.toHaveBeenCalled();
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it("does not open a cleanup transaction when no strict excess rows exist", async () => {
    const cleanAudit = { ...audit, strictGroups: 0, strictExcessRows: 0, strictExcessTokens: 0 };
    const store = storeWithAudit(cleanAudit);

    await expect(cleanupExactUsageDuplicates({ store, confirm: true })).resolves.toEqual({
      ...cleanAudit,
      executed: false,
      batchId: null,
      backedUp: 0,
      deleted: 0,
      rollupsRebuilt: 0
    });
    expect(store.cleanup).not.toHaveBeenCalled();
  });

  it("backs up and deletes only the strict excess rows on confirmed cleanup", async () => {
    const store = storeWithAudit(audit);
    vi.mocked(store.cleanup).mockResolvedValue({
      batchId: "00000000-0000-4000-8000-000000000099",
      backedUp: 2,
      deleted: 2,
      rollupsRebuilt: 7
    });

    await expect(cleanupExactUsageDuplicates({ store, confirm: true })).resolves.toEqual({
      ...audit,
      executed: true,
      batchId: "00000000-0000-4000-8000-000000000099",
      backedUp: 2,
      deleted: 2,
      rollupsRebuilt: 7
    });
    expect(store.cleanup).toHaveBeenCalledOnce();
  });
});

function storeWithAudit(value: ExactDuplicateAudit): ExactDuplicateStore {
  return {
    audit: vi.fn().mockResolvedValue(value),
    cleanup: vi.fn()
  };
}
