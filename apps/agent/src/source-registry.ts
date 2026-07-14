import type { AgentStateV2, FileCursorState, FileTombstone, ParserState } from "./state.js";
import type { FileObservation } from "./file-identity.js";

export type { FileObservation } from "./file-identity.js";

export type SourceMatch =
  | { kind: "new" }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "existing"; identity: string; sourceIdentity: string }
  | { kind: "rename"; identity: string; sourceIdentity: string }
  | { kind: "truncation"; identity: string; sourceIdentity: string }
  | { kind: "replacement"; replacedIdentity: string }
  | { kind: "tombstone"; identity: string; sourceIdentity: string };

export function matchObservation(state: AgentStateV2, observation: FileObservation): SourceMatch {
  if (observation.identity) {
    const exact = findByIdentity(state, observation.identity);
    if (exact) return classifyIdentityMatch(exact, observation);
  }

  if (observation.fallbackSignature) {
    const candidates = findByFallback(state, observation.fallbackSignature);
    if (candidates.length > 1) {
      return { kind: "ambiguous", candidates: candidates.map(({ identity }) => identity).sort() };
    }
    if (candidates[0]) return classifyIdentityMatch(candidates[0], observation);
  }

  const pathIdentity = state.paths[observation.path];
  const pathFile = pathIdentity ? state.files[pathIdentity] : undefined;
  if (!pathFile) return { kind: "new" };
  if (!observation.identity && !observation.fallbackSignature) {
    return observation.size < pathFile.observedSize
      ? { kind: "truncation", identity: pathFile.identity, sourceIdentity: pathFile.sourceIdentity }
      : { kind: "existing", identity: pathFile.identity, sourceIdentity: pathFile.sourceIdentity };
  }
  return { kind: "replacement", replacedIdentity: pathFile.identity };
}

export function registerRename(
  state: AgentStateV2,
  identity: string,
  observation: FileObservation
): AgentStateV2 {
  const next = structuredClone(state);
  const file = requiredFile(next, identity);
  delete next.paths[file.currentPath];
  file.currentPath = observation.path;
  file.observedSize = observation.size;
  file.observedMtimeMs = observation.mtimeMs;
  next.paths[observation.path] = identity;
  return next;
}

export function registerReplacement(
  state: AgentStateV2,
  replacedIdentity: string,
  replacement: FileCursorState
): AgentStateV2 {
  const next = structuredClone(state);
  const previous = requiredFile(next, replacedIdentity);
  next.tombstones[replacedIdentity] = toTombstone(previous);
  delete next.files[replacedIdentity];
  delete next.paths[previous.currentPath];
  const reset = resetCursor(replacement, replacement.parser);
  next.files[reset.identity] = reset;
  next.paths[reset.currentPath] = reset.identity;
  return next;
}

export function registerTruncation(
  state: AgentStateV2,
  identity: string,
  observation: FileObservation
): AgentStateV2 {
  const next = structuredClone(state);
  const file = requiredFile(next, identity);
  const reset = resetCursor(
    { ...file, currentPath: observation.path, observedSize: observation.size, observedMtimeMs: observation.mtimeMs },
    { kind: file.parser.kind }
  );
  next.files[identity] = reset;
  next.paths[observation.path] = identity;
  return next;
}

export function tombstoneMissingFiles(state: AgentStateV2, observedIdentities: Set<string>): AgentStateV2 {
  const next = structuredClone(state);
  for (const [identity, file] of Object.entries(next.files)) {
    if (observedIdentities.has(identity)) continue;
    next.tombstones[identity] = toTombstone(file);
    delete next.files[identity];
    delete next.paths[file.currentPath];
  }
  return next;
}

function classifyIdentityMatch(
  record: FileCursorState | FileTombstone,
  observation: FileObservation
): SourceMatch {
  if (!("parser" in record)) {
    return { kind: "tombstone", identity: record.identity, sourceIdentity: record.sourceIdentity };
  }
  if (record.currentPath !== observation.path) {
    return { kind: "rename", identity: record.identity, sourceIdentity: record.sourceIdentity };
  }
  if (observation.size < record.observedSize) {
    return { kind: "truncation", identity: record.identity, sourceIdentity: record.sourceIdentity };
  }
  return { kind: "existing", identity: record.identity, sourceIdentity: record.sourceIdentity };
}

function findByIdentity(state: AgentStateV2, identity: string): FileCursorState | FileTombstone | undefined {
  return state.files[identity] ?? state.tombstones[identity];
}

function findByFallback(state: AgentStateV2, signature: string): Array<FileCursorState | FileTombstone> {
  return [...Object.values(state.files), ...Object.values(state.tombstones)]
    .filter((entry) => entry.fallbackSignature === signature);
}

function resetCursor(file: FileCursorState, parser: ParserState): FileCursorState {
  return {
    ...file,
    offset: 0,
    nextLineNumber: 1,
    pendingBase64: "",
    discardUntilNewline: false,
    parser
  };
}

function requiredFile(state: AgentStateV2, identity: string): FileCursorState {
  const file = state.files[identity];
  if (!file) throw new Error(`tracked file identity not found: ${identity}`);
  return file;
}

function toTombstone(file: FileCursorState): FileTombstone {
  return {
    identity: file.identity,
    fallbackSignature: file.fallbackSignature,
    currentPath: file.currentPath,
    sourceIdentity: file.sourceIdentity,
    offset: file.offset,
    nextLineNumber: file.nextLineNumber,
    discardUntilNewline: file.discardUntilNewline,
    observedSize: file.observedSize,
    observedMtimeMs: file.observedMtimeMs
  };
}
