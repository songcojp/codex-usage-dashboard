import { describe, expect, it } from "vitest";
import { initialAgentState, type AgentStateV2, type FileCursorState } from "./state.js";
import {
  matchObservation,
  registerRename,
  registerReplacement,
  registerTruncation,
  tombstoneMissingFiles,
  type FileObservation
} from "./source-registry.js";

const originalPath = "/logs/Codex.log";
const rotatedPath = "/logs/Codex.1.log";

describe("source registry", () => {
  it("matches rename by identity before path", () => {
    const state = stateWithFile(file({ identity: "dev:7:ino:9:birth:11", currentPath: originalPath }));
    const match = matchObservation(state, observation({
      identity: "dev:7:ino:9:birth:11",
      path: rotatedPath
    }));

    expect(match).toMatchObject({ kind: "rename", identity: "dev:7:ino:9:birth:11", sourceIdentity: "old-path-hash" });
  });

  it("does not guess ambiguous fallback identity", () => {
    const state = initialAgentState();
    state.files.one = file({ identity: "one", fallbackSignature: "fallback:same", currentPath: "/logs/one" });
    state.files.two = file({ identity: "two", fallbackSignature: "fallback:same", currentPath: "/logs/two" });

    expect(matchObservation(state, observation({ identity: null, fallbackSignature: "fallback:same" })))
      .toEqual({ kind: "ambiguous", candidates: ["one", "two"] });
  });

  it("detects path replacement and same-identity truncation", () => {
    const state = stateWithFile(file({ observedSize: 500 }));

    expect(matchObservation(state, observation({ identity: "different", size: 20 })))
      .toMatchObject({ kind: "replacement", replacedIdentity: "primary" });
    expect(matchObservation(state, observation({ identity: "primary", size: 20 })))
      .toMatchObject({ kind: "truncation", identity: "primary" });
  });

  it("keeps empty fallback files path-bound until a complete line exists", () => {
    const state = stateWithFile(file({ identity: "path-bound:one", fallbackSignature: null }));
    const samePath = matchObservation(state, observation({ identity: null, fallbackSignature: null }));
    const otherPath = matchObservation(state, observation({ identity: null, fallbackSignature: null, path: "/logs/other" }));

    expect(samePath).toMatchObject({ kind: "existing", identity: "path-bound:one" });
    expect(otherPath).toEqual({ kind: "new" });
  });

  it("preserves source identity on rename and resets replacement or truncation", () => {
    const renamed = registerRename(stateWithFile(file()), "primary", observation({ path: rotatedPath }));
    expect(renamed.files.primary).toMatchObject({ currentPath: rotatedPath, offset: 100, sourceIdentity: "old-path-hash" });

    const replacement = file({ identity: "replacement", currentPath: originalPath, sourceIdentity: "new-path-hash" });
    const replaced = registerReplacement(stateWithFile(file()), "primary", replacement);
    expect(replaced.files.replacement).toMatchObject({ offset: 0, nextLineNumber: 1, sourceIdentity: "new-path-hash" });
    expect(replaced.files.primary).toBeUndefined();

    const truncated = registerTruncation(stateWithFile(file()), "primary", observation({ size: 5 }));
    expect(truncated.files.primary).toMatchObject({ offset: 0, nextLineNumber: 1, pendingBase64: "", observedSize: 5 });
    expect(truncated.files.primary?.parser).toEqual({ kind: "codex-vscode" });
  });

  it("retains lifetime tombstones for missing files and matches them before replay", () => {
    const state = tombstoneMissingFiles(stateWithFile(file()), new Set());
    expect(state.files.primary).toBeUndefined();
    expect(state.tombstones.primary).toMatchObject({ identity: "primary", sourceIdentity: "old-path-hash", offset: 100 });
    expect(matchObservation(state, observation({ identity: "primary", path: rotatedPath })))
      .toMatchObject({ kind: "tombstone", identity: "primary" });
  });
});

function stateWithFile(cursor: FileCursorState): AgentStateV2 {
  const state = initialAgentState();
  state.files[cursor.identity] = cursor;
  state.paths[cursor.currentPath] = cursor.identity;
  return state;
}

function file(overrides: Partial<FileCursorState> = {}): FileCursorState {
  return {
    identity: "primary",
    fallbackSignature: null,
    currentPath: originalPath,
    sourceIdentity: "old-path-hash",
    offset: 100,
    nextLineNumber: 8,
    pendingBase64: "cGFydGlhbA==",
    discardUntilNewline: false,
    observedSize: 500,
    observedMtimeMs: 1000,
    parser: { kind: "codex-vscode" },
    ...overrides
  };
}

function observation(overrides: Partial<FileObservation> = {}): FileObservation {
  return {
    path: originalPath,
    identity: "primary",
    fallbackSignature: null,
    size: 500,
    mtimeMs: 1000,
    ...overrides
  };
}
