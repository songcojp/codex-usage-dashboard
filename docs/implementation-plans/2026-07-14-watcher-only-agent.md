# Watcher-only Agent Implementation Plan

> Implement this plan task by task. Every task follows a red-green test cycle, passes focused verification, and receives review before the next task begins.

**Goal:** Replace scheduled whole-file scans with one crash-safe watcher that incrementally reads Codex logs, uploads through a durable bounded queue, reconciles every six hours, and installs as the only automatic Agent process.

**Architecture:** A byte-framing layer produces complete physical-line checkpoints; stateful parser adapters convert those lines into stable usage events. One watcher owns file discovery, cursor state, queue mutation, upload retries, and periodic reconciliation. Versioned state is keyed by stable file identity, while an OS-released local IPC endpoint prevents a second writer. Linux systemd and Windows Task Scheduler install one supervised watcher and remove scheduled scans only after a healthy cutover.

**Tech Stack:** Node.js 20.19+, TypeScript 5.5+, Vitest 4, Node `fs`, `net`, and `node:test`, Bash 4+, systemd user services, Windows Task Scheduler.

## Global constraints

- Do not create or commit files below `docs/superpowers/`.
- Do not commit or log tokens, credentials, private CA material, absolute project paths, prompts, source lines, or malformed payload contents.
- The only automatic mode is `watch`; remove `scan`, `upload`, `install-scheduler`, `--upload`, and scheduled scan intervals.
- Do not support the legacy Agent, legacy configuration directory, removed tool slugs, or non-Codex sources.
- Keep `codex-desktop` independent from `codex-vscode-plugin`; unknown Codex origins map to `other`.
- Reconcile inside the watcher every six hours; never start a second scanning process.
- Read no more than 4 MiB and emit no more than 500 events per source chunk.
- Keep pending physical-line bytes at or below 1 MiB and the active queue at or below 100 MiB.
- Use mode `0600` for configuration, queue, dead-letter, state, and backups; use `0700` for containing directories.
- Preserve current new-project source event IDs for the same source records.
- Queue durability precedes cursor advancement; invalid or unaccounted acknowledgements never remove events.
- Linux uses a hashed abstract Unix socket and Windows a hashed named pipe for the single-instance lock.
- Every code task follows TDD: add a failing test, observe RED, implement minimum behavior, verify GREEN, then commit.

---

### Task 1: Versioned state and raw-byte line framing

**Files:**

- Create: `apps/agent/src/atomic-file.ts`
- Create: `apps/agent/src/line-reader.ts`
- Create: `apps/agent/src/line-reader.test.ts`
- Create: `apps/agent/src/state.ts`
- Create: `apps/agent/src/state.test.ts`
- Modify: `apps/agent/src/config.ts`
- Modify: `apps/agent/src/config.test.ts`

**Interfaces:**

- Produces `atomicWriteFile(filePath, content, mode?): Promise<void>`.
- Produces `readLineChunk(input): Promise<ReadLineChunkResult>`.
- Produces `readAgentState(filePath?): Promise<AgentStateV2>` and `writeAgentState(state, filePath?): Promise<void>`.

- [ ] **Step 1: Add failing state and framing tests**

```ts
const initialState: AgentStateV2 = {
  version: 2,
  lastSourceAdvanceAt: null,
  lastUploadAt: null,
  lastReconciliationAt: null,
  lastErrorCategory: null,
  queueDepth: 0,
  files: {}, paths: {}, tombstones: {}
};

it("frames UTF-8 and a trailing partial line without double-reading", async () => {
  await fs.writeFile(file, Buffer.from('one\n{"text":"你'));
  const first = await readLineChunk({ filePath: file, cursor: emptyCursor(), maxBytes: 4 * 1024 * 1024 });
  expect(first.lines.map((line) => line.text)).toEqual(["one"]);
  await fs.appendFile(file, Buffer.from('好"}\n'));
  const second = await readLineChunk({ filePath: file, cursor: first.cursor, maxBytes: 4 * 1024 * 1024 });
  expect(second.lines.map((line) => line.text)).toEqual(['{"text":"你好"}']);
  expect(second.lines[0]?.lineNumber).toBe(2);
});

it("rejects unversioned state", async () => {
  await fs.writeFile(statePath, JSON.stringify({ lastScanAt: null, fileFingerprints: {} }));
  await expect(readAgentState(statePath)).rejects.toThrow(/unsupported agent state version/);
});
```

Also test CRLF removal, physical-line numbering including empty lines, 1 MiB discard mode, atomic replacement, and required file/directory modes.
Also require a missing state file to return a fresh version-2 state with `queueDepth: 0`.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/line-reader.test.ts src/state.test.ts src/config.test.ts
```

Expected: FAIL because the modules and version-2 state do not exist and config still requires `scanInterval`.

- [ ] **Step 3: Implement state and framing primitives**

Define in `state.ts`:

```ts
export type ParserState = {
  kind: "codex-jsonl" | "codex-vscode";
  sessionId?: string | null;
  cwd?: string | null;
  model?: string | null;
  toolSlug?: "codex-cli" | "codex-vscode-plugin" | "codex-desktop" | "other";
};

export type FileCursorState = {
  identity: string; fallbackSignature: string | null;
  currentPath: string; sourceIdentity: string;
  offset: number; nextLineNumber: number; pendingBase64: string;
  discardUntilNewline: boolean; observedSize: number; observedMtimeMs: number;
  parser: ParserState;
};

export type AgentStateV2 = {
  version: 2;
  lastSourceAdvanceAt: string | null; lastUploadAt: string | null;
  lastReconciliationAt: string | null; lastErrorCategory: string | null;
  queueDepth: number;
  files: Record<string, FileCursorState>; paths: Record<string, string>;
  tombstones: Record<string, Omit<FileCursorState, "parser" | "pendingBase64">>;
};
```

`readLineChunk` reads raw bytes from `cursor.offset`, prepends pending bytes once, splits on `0x0a`, strips one `0x0d`, and decodes only complete lines. Its returned offset is the first unread file byte; pending bytes are already behind it. Overlong lines enter discard-until-newline mode. Move state I/O out of `config.ts` and remove `scanInterval` from `AgentConfig`.

- [ ] **Step 4: Verify GREEN**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/line-reader.test.ts src/state.test.ts src/config.test.ts
npm --workspace @codex-usage-dashboard/agent run typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/atomic-file.ts apps/agent/src/line-reader.ts apps/agent/src/line-reader.test.ts apps/agent/src/state.ts apps/agent/src/state.test.ts apps/agent/src/config.ts apps/agent/src/config.test.ts
git commit -m "feat(agent): add durable incremental cursor state"
```

---

### Task 2: Incremental Codex parser adapters

**Files:**

- Modify: `apps/agent/src/parsers/types.ts`
- Modify: `apps/agent/src/parsers/codex.ts`
- Modify: `apps/agent/src/parsers/codex-vscode.ts`
- Modify: `apps/agent/src/parsers/index.ts`
- Modify: `apps/agent/src/parsers/parsers.test.ts`

**Interfaces:**

- Consumes Task 1 complete physical lines and parser state.
- Produces `IncrementalParserAdapter<C>`, `parseCodexLine`, and `parseCodexVsCodeLine`.

- [ ] **Step 1: Add failing parser-equivalence tests**

```ts
it("preserves Codex context and IDs across incremental calls", async () => {
  let context = initialCodexContext();
  for (const [index, line] of fixtureLines.entries()) {
    const result = await parseCodexLine({ line, lineNumber: index + 1, context,
      sourceIdentity: "unused", filePath: fixturePath, finalTail: false });
    context = result.context;
    if (result.event) incremental.push(result.event);
  }
  expect(incremental).toEqual(await parseCodexFile(fixturePath));
});

it("keeps VS Code source identity after rename", async () => {
  const sourceIdentity = sha256Hex(`path:${originalPath}`);
  const before = await parseCodexVsCodeLine(input(usageLine, originalPath, sourceIdentity));
  const after = await parseCodexVsCodeLine(input(usageLine, renamedPath, sourceIdentity));
  expect(after.event?.sourceEventId).toBe(before.event?.sourceEventId);
});
```

Cover Desktop, VS Code, CLI, unknown-to-`other`, empty/non-target lines, malformed targets returning only a category/hash, and a rotated final tail.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/parsers/parsers.test.ts
```

Expected: FAIL because line-oriented adapters do not exist.

- [ ] **Step 3: Implement line-oriented state machines**

```ts
export type ParseLineInput<C> = {
  line: string; lineNumber: number; context: C;
  sourceIdentity: string; filePath: string; finalTail: boolean;
};
export type ParseLineResult<C> = {
  context: C; event?: UsageEventDraft;
  malformed?: { category: string; sourceHash: string };
};
export interface IncrementalParserAdapter<C> extends ParserAdapter {
  initialContext(): C;
  parseLine(input: ParseLineInput<C>): Promise<ParseLineResult<C>>;
}
```

Move the current Codex state machine into `parseCodexLine`: `session_meta` updates session/cwd/tool, `turn_context` updates cwd/model, and only token-count records emit events. Preserve current source ID inputs including physical line number. Make VS Code use supplied `sourceIdentity`, never the renamed current path.

- [ ] **Step 4: Verify parser equivalence**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/parsers/parsers.test.ts
npm --workspace @codex-usage-dashboard/agent run typecheck
```

Expected: all parser fixtures produce equivalent event objects and IDs.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/parsers
git commit -m "feat(agent): parse Codex logs incrementally"
```

---

### Task 3: Stable file identity and rotation tracking

**Files:**

- Create: `apps/agent/src/file-identity.ts`
- Create: `apps/agent/src/file-identity.test.ts`
- Create: `apps/agent/src/source-registry.ts`
- Create: `apps/agent/src/source-registry.test.ts`
- Modify: `apps/agent/src/state.ts`

**Interfaces:**

- Produces `observeFile(filePath): Promise<FileObservation>` and `matchObservation(state, observation): SourceMatch`.
- Produces `registerReplacement`, `registerRename`, `registerTruncation`, and `tombstoneMissingFiles`.

- [ ] **Step 1: Add failing identity tests**

```ts
it("matches rename by identity before path", () => {
  const state = stateWithFile({ identity: "dev:7:ino:9:birth:11", currentPath: originalPath,
    sourceIdentity: oldPathHash });
  expect(matchObservation(state, observation({ identity: "dev:7:ino:9:birth:11", path: rotatedPath })))
    .toMatchObject({ kind: "rename", sourceIdentity: oldPathHash });
});

it("does not guess ambiguous fallback identity", () => {
  expect(matchObservation(stateWithTwoEqualFallbacks(), fallbackObservation))
    .toEqual({ kind: "ambiguous", candidates: expect.any(Array) });
});
```

Also test replacement, truncation, lifetime tombstones, and empty fallback files remaining path-bound until their first complete line.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/file-identity.test.ts src/source-registry.test.ts
```

Expected: FAIL because identity and registry modules do not exist.

- [ ] **Step 3: Implement identity-first matching**

Use `fs.stat(filePath, { bigint: true })` and serialize reliable device, inode, and creation values:

```ts
`dev:${stat.dev}:ino:${stat.ino}:birth:${stat.birthtimeNs}`
```

Fallback is `fallback:${birthMarker}:${sha256Hex(firstCompleteLine)}`. Never log the line/path. Match primary identity, then a unique fallback, then path. Rename preserves cursor/source identity; replacement/truncation resets the cursor; ambiguity does not advance.

- [ ] **Step 4: Verify GREEN**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/file-identity.test.ts src/source-registry.test.ts
npm --workspace @codex-usage-dashboard/agent run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/file-identity.ts apps/agent/src/file-identity.test.ts apps/agent/src/source-registry.ts apps/agent/src/source-registry.test.ts apps/agent/src/state.ts
git commit -m "feat(agent): track rotated logs by stable identity"
```

---

### Task 4: Durable bounded queue and strict acknowledgements

**Files:**

- Modify: `apps/agent/src/queue.ts`
- Modify: `apps/agent/src/queue.test.ts`
- Create: `apps/agent/src/acknowledgement.ts`
- Create: `apps/agent/src/acknowledgement.test.ts`
- Modify: `apps/agent/src/upload.ts`
- Modify: `apps/agent/src/upload.test.ts`

**Interfaces:**

- Produces `DurableQueue.open(options)`, `enqueue`, `peek`, `acknowledge`, `depth`, and `sizeBytes`.
- Produces `validateAcknowledgement(sent, response): ValidatedAcknowledgement`.

- [ ] **Step 1: Add failing durability tests**

```ts
it("deduplicates crash replay", async () => {
  await queue.enqueue([event("same-id")]);
  await queue.enqueue([event("same-id")]);
  expect(await queue.peek(500)).toHaveLength(1);
});

it("retains unaccounted success", async () => {
  await queue.enqueue([event("a"), event("b")]);
  await expect(queue.acknowledge(await queue.peek(500), {
    inserted: 1, duplicates: 0, rejected: []
  })).rejects.toThrow(/unaccounted acknowledgement/);
  expect(await queue.peek(500)).toHaveLength(2);
});
```

Test dead-letter-before-compaction, rejected-ID validation, `0600`/`0700` modes, atomic compaction, dead-letter dedupe, and an injected small queue limit.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/queue.test.ts src/acknowledgement.test.ts src/upload.test.ts
```

Expected: FAIL because queue append/clear is unconditional.

- [ ] **Step 3: Implement durable acknowledgement**

Stream the JSONL queue on open to build `(toolSlug, sourceEventId)` keys. Append only unseen events, synchronize the file, and reject data over `100 * 1024 * 1024` bytes. Require:

```ts
inserted + duplicates + rejected.length === sent.length
```

Every rejected ID must occur once in the batch. Synchronize mode-`0600` dead-letter entries before atomically rewriting the unacknowledged suffix. Never clear on malformed/partial responses.

- [ ] **Step 4: Verify GREEN**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/queue.test.ts src/acknowledgement.test.ts src/upload.test.ts
npm --workspace @codex-usage-dashboard/agent run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/queue.ts apps/agent/src/queue.test.ts apps/agent/src/acknowledgement.ts apps/agent/src/acknowledgement.test.ts apps/agent/src/upload.ts apps/agent/src/upload.test.ts
git commit -m "feat(agent): make upload queue crash safe"
```

---

### Task 5: Bounded source processing and retry pipeline

**Files:**

- Create: `apps/agent/src/processor.ts`
- Create: `apps/agent/src/processor.test.ts`
- Create: `apps/agent/src/retry.ts`
- Create: `apps/agent/src/retry.test.ts`
- Modify: `apps/agent/src/runtime.ts`
- Modify: `apps/agent/src/runtime.test.ts`

**Interfaces:**

- Produces `processSourceFile(input): Promise<ProcessSourceResult>` and `drainUploadQueue(input): Promise<DrainResult>`.
- Produces `RetryBackoff` with 30-second initial and 30-minute maximum delay.

- [ ] **Step 1: Add failing processor tests**

```ts
it("persists queue before cursor", async () => {
  const result = await processSourceFile(fixture({ failQueueSync: true }));
  expect(result.ok).toBe(false);
  expect((await readAgentState()).files[fileId]?.offset).toBe(0);
});

it("stops at the accepted checkpoint when queue is full", async () => {
  const result = await processSourceFile(fixture({ maxQueueBytes: bytesForOneEvent }));
  expect(result.queued).toBe(1);
  expect(result.remaining).toBeGreaterThan(0);
  expect((await readAgentState()).files[fileId]?.nextLineNumber).toBe(2);
});
```

Test 4 MiB/500-event bounds, non-event advancement, malformed-line advancement, transient errors without advancement, queue-first startup draining, 401 retry frequency, exponential backoff reset, and partial acknowledgement retention.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/processor.test.ts src/retry.test.ts src/runtime.test.ts
```

Expected: FAIL because runtime still scans whole files.

- [ ] **Step 3: Implement serialized processing**

Read one bounded chunk, fold complete lines through the parser, and retain a state snapshot per checkpoint. Choose the largest event prefix fitting the queue. Enqueue/synchronize before writing that checkpoint. Non-event lines may advance without enqueue. Drain at most 500 events, validate Task 4 responses, update `lastUploadAt` only after acknowledgement, and retain all data on failures. Backoff doubles from 30 seconds to a 30-minute cap.

- [ ] **Step 4: Verify GREEN**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/processor.test.ts src/retry.test.ts src/runtime.test.ts
npm --workspace @codex-usage-dashboard/agent run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/processor.ts apps/agent/src/processor.test.ts apps/agent/src/retry.ts apps/agent/src/retry.test.ts apps/agent/src/runtime.ts apps/agent/src/runtime.test.ts
git commit -m "feat(agent): process bounded log increments"
```

---

### Task 6: Single-instance watcher and internal reconciliation

**Files:**

- Create: `apps/agent/src/process-lock.ts`
- Create: `apps/agent/src/process-lock.test.ts`
- Create: `apps/agent/src/watcher.integration.test.ts`
- Modify: `apps/agent/src/watcher.ts`
- Modify: `apps/agent/src/watcher.test.ts`

**Interfaces:**

- Produces `acquireProcessLock(configDir, platform?): Promise<ProcessLock>`.
- Produces `runWatcher(options): Promise<never>` as the only automatic loop.

- [ ] **Step 1: Add failing lock and watcher tests**

```ts
it("allows one lock owner and releases on close", async () => {
  const first = await acquireProcessLock(configDir, process.platform);
  await expect(acquireProcessLock(configDir, process.platform)).rejects.toThrow(/already running/);
  await first.release();
  await expect(acquireProcessLock(configDir, process.platform)).resolves.toBeDefined();
});

it("serializes filesystem and reconciliation cycles", async () => {
  const watcher = watcherHarness({ reconciliationMs: 6 * 60 * 60 * 1000 });
  watcher.emitFileChange(file);
  watcher.advanceClock(6 * 60 * 60 * 1000);
  await watcher.flush();
  expect(watcher.maxConcurrentCycles).toBe(1);
  expect(watcher.reasons).toEqual(["startup", "filesystem", "reconciliation"]);
});
```

Also test new-directory registration, missing event filename fallback, two-second debounce, pending work after a long upload, retry without source changes, and clean shutdown.

In `watcher.integration.test.ts`, start a real local HTTP server and real watcher against temporary Codex/VS Code roots. Append a record across UTF-8 byte boundaries, rotate a file, create a nested session directory, inject one malformed target, one 401, one partial acknowledgement, and one network outage, then require every unique valid source ID to arrive and the queue to return to zero without raw paths/content in logs.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/process-lock.test.ts src/watcher.test.ts src/watcher.integration.test.ts
```

Expected: FAIL because lock and internal reconciliation do not exist.

- [ ] **Step 3: Implement OS-released IPC lock and watcher loop**

```ts
const id = sha256Hex(path.resolve(configDir)).slice(0, 24);
const endpoint = platform === "win32"
  ? `\\\\?\\pipe\\codex-usage-dashboard-agent-${id}`
  : platform === "linux"
    ? `\0codex-usage-dashboard-agent-${id}`
    : null;
```

Bind a `net.Server`; translate `EADDRINUSE` to `AgentAlreadyRunningError`; fail closed on unsupported platforms. Keep the server alive until release. Refactor watcher into one pending-reason loop: drain queue, startup reconcile, register native directory watches, process debounced changes, refresh for new directories, schedule six-hour reconciliation, and schedule upload retries without concurrent cycles.

- [ ] **Step 4: Verify GREEN**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/process-lock.test.ts src/watcher.test.ts src/watcher.integration.test.ts
npm --workspace @codex-usage-dashboard/agent run typecheck
```

Expected: second lock fails and controlled-clock reconciliation runs exactly once.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/process-lock.ts apps/agent/src/process-lock.test.ts apps/agent/src/watcher.ts apps/agent/src/watcher.test.ts apps/agent/src/watcher.integration.test.ts
git commit -m "feat(agent): run one self-reconciling watcher"
```

---

### Task 7: Watcher-only CLI, health status, and service definitions

**Files:**

- Modify: `apps/agent/src/cli.ts`
- Create: `apps/agent/src/cli.test.ts`
- Modify: `apps/agent/src/scheduler/systemd.ts`
- Modify: `apps/agent/src/scheduler/windows.ts`
- Modify: `apps/agent/src/scheduler/scheduler.test.ts`
- Delete: `apps/agent/src/scheduler/resolve.ts`
- Delete: `apps/agent/src/scheduler/resolve.test.ts`

**Interfaces:**

- Produces CLI commands `watch`, `status`, and `reset-state` only.
- Produces `systemdService(target): string` and `windowsWatcherTaskXml(target): string`.

- [ ] **Step 1: Add failing CLI/scheduler tests**

```ts
it("exposes watcher and diagnostics only", () => {
  const help = runCli(["--help"]);
  expect(help.stdout).toContain("watch");
  expect(help.stdout).toContain("status");
  expect(help.stdout).toContain("reset-state");
  expect(help.stdout).not.toMatch(/\bscan\b|install-scheduler/);
});

it("builds one supervised systemd watcher", () => {
  const unit = systemdService(target);
  expect(unit).toContain("Type=simple");
  expect(unit).toContain(" watch");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).not.toMatch(/scan|OnCalendar|--upload/);
});
```

Windows XML tests require `LogonTrigger`, `MultipleInstancesPolicy=IgnoreNew`, `PT30S` restart, watcher action without `--upload`, and no scan task.

- [ ] **Step 2: Run tests and confirm RED**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/cli.test.ts src/scheduler/scheduler.test.ts
```

Expected: FAIL because current CLI and scheduler expose scan/timer behavior.

- [ ] **Step 3: Implement watcher-only surface**

`watch` opens config, state, and durable queue, acquires the lock, and starts `runWatcher`; upload is mandatory. Every queue mutation writes the resulting depth into state after the queue operation is durable. `status` reads the atomic state snapshot rather than racing the live queue file and prints only:

```ts
{
  ok, stateVersion: 2, lastSourceAdvanceAt, lastUploadAt, lastReconciliationAt,
  trackedFiles, queueDepth, lastErrorCategory
}
```

`reset-state` refuses while the lock is held and requires `--confirm`. It archives the active state with mode `0600`, creates a fresh version-2 state, and never deletes or truncates the queue or dead-letter file. Remove scan, upload, install-scheduler, interval parsing, timer generation, and resolver code.

- [ ] **Step 4: Verify GREEN**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/cli.test.ts src/scheduler/scheduler.test.ts
npm --workspace @codex-usage-dashboard/agent run typecheck
```

Expected: help lists exactly the three supported commands.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/cli.ts apps/agent/src/cli.test.ts apps/agent/src/scheduler/systemd.ts apps/agent/src/scheduler/windows.ts apps/agent/src/scheduler/scheduler.test.ts
git rm apps/agent/src/scheduler/resolve.ts apps/agent/src/scheduler/resolve.test.ts
git commit -m "feat(agent): expose watcher-only runtime"
```

---

### Task 8: Transactional Linux and Windows installation

**Files:**

- Create: `scripts/lib/install-agent.sh`
- Modify: `scripts/install-agent.sh`
- Modify: `scripts/install-agent.test.mjs`
- Modify: `README.md`

**Interfaces:**

- Produces installer option `--allow-session-only`; removes `--interval`.
- Produces shell functions `preflight_agent_install`, `backup_agent_install`, `cutover_agent_service`, and `rollback_agent_install`.

- [ ] **Step 1: Add failing installer and rollback tests**

Extend the harness with fake `systemctl`, `loginctl`, and health commands:

```js
test("dry run installs one watcher and no timer", () => {
  const result = runInstaller([...validArgs, "--dry-run"], validEnv);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ExecStart=.* watch$/m);
  assert.doesNotMatch(result.stdout, /OnCalendar|scan --upload|watch --upload/);
});

test("failed health restores prior unit state", () => {
  const result = runInstaller(validArgs, fakeSystemdEnv({ health: "fail", oldTimer: "active" }));
  assert.notEqual(result.status, 0);
  assert.deepEqual(readCalls(), ["preflight", "backup", "stop-old", "install-new",
    "daemon-reload", "start-new", "health-failed", "restore-old",
    "daemon-reload", "start-old-timer"]);
});
```

Test that disabled lingering aborts before service mutation unless explicitly accepted, backups use protected modes, unversioned state is archived, queue is preserved, and Windows removes scan task only after watcher health succeeds.

- [ ] **Step 2: Run tests and confirm RED**

```bash
node --test scripts/install-agent.test.mjs
```

Expected: FAIL because installer still enables timer plus watcher and has no rollback.

- [ ] **Step 3: Implement transactional cutover**

Move reusable functions into `scripts/lib/install-agent.sh`. Before mutation: build Agent, validate config/executable, stage and verify unit, check user systemd, and check `loginctl show-user "$USER" -p Linger --value`. Abort before cutover unless lingering is enabled or `--allow-session-only` is explicit.

Create timestamped mode-`0700` backup directory and mode-`0600` copies. Stop old timer/one-shot/separate watcher after backup. Atomically install one service, reload, enable, and require 30 seconds active plus startup health. On failure, preserve new queue/dead-letter under recovery names and restore exact previous states. Windows exports old tasks, registers and health-checks one restartable watcher, then removes scan task.

For the existing unversioned fingerprint state, move the active `state.json` into the protected backup after old services stop and before the replacement starts. The missing active state then initializes as version 2; never pass the unversioned file to the new watcher.

- [ ] **Step 4: Verify GREEN and shell safety**

```bash
bash -n scripts/install-agent.sh scripts/lib/install-agent.sh
node --test scripts/install-agent.test.mjs
npm run check:open-source
```

Expected: tests pass, dry-run contains no timer/secret, safety scan has no findings.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/install-agent.sh scripts/install-agent.sh scripts/install-agent.test.mjs README.md
git commit -m "feat(agent): install one supervised watcher"
```

---

### Task 9: Remove obsolete scan code and complete documentation

**Files:**

- Modify: `apps/agent/src/parsers/parsers.test.ts`
- Modify: `apps/agent/src/runtime.test.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes the Task 6 end-to-end watcher test as the safety net for final refactoring.

- [ ] **Step 1: Establish a GREEN refactoring baseline**

```bash
npm --workspace @codex-usage-dashboard/agent test -- src/watcher.integration.test.ts
```

Expected: PASS before obsolete code is removed.

- [ ] **Step 2: Remove obsolete scan code and update docs**

Delete whole-file runtime paths, timer docs, hourly/daily examples, and `watch --upload`. Keep whole-file parser helpers only if equivalence tests require them. Document watcher startup, six-hour reconciliation, 100 MiB queue, main service name, and removed timer/separate-watcher units.

- [ ] **Step 3: Re-run focused Agent verification after refactoring**

```bash
npm --workspace @codex-usage-dashboard/agent test
npm --workspace @codex-usage-dashboard/agent run typecheck
```

Expected: the same Agent suite remains GREEN after removal.

- [ ] **Step 4: Run full repository verification**

```bash
npm run typecheck
npm test
npm run build
npm run check:open-source
git diff --check
```

Expected: all workspaces, build, safety scan, and whitespace check pass.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/parsers/parsers.test.ts apps/agent/src/runtime.test.ts README.md
git commit -m "test(agent): verify watcher-only delivery"
```

---

### Task 10: Review, publish, cut over, and verify production Agent

**Files:**

- No repository files change during this operational task.
- Runtime backups remain outside Git.

**Interfaces:**

- Produces one merged branch, one active watcher service, no scan timer, and verified new ingestion.

- [ ] **Step 1: Review and publish the branch**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
git diff --check origin/main...HEAD
git push -u origin codex/watcher-only-agent
gh pr create --draft --title "feat: run a watcher-only usage agent" --body $'## Summary\n- replace scheduled scans with one incremental watcher\n- add bounded durable queue and rotation-safe cursors\n- add transactional service cutover and rollback\n\n## Verification\n- npm run typecheck\n- npm test\n- npm run build\n- npm run check:open-source'
```

PR body summarizes state schema, bounded queue, rotation, removed commands/units, rollback, and verification without private values.

- [ ] **Step 2: Require CI and review before merge**

```bash
gh pr checks --watch
gh pr ready
gh pr merge --merge --delete-branch
```

Capture the merge commit, identify its Deploy workflow run, and require it to succeed:

```bash
merge_sha=$(gh pr view --json mergeCommit --jq '.mergeCommit.oid')
deploy_run=$(gh run list --workflow Deploy --commit "$merge_sha" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$deploy_run" --exit-status
```

Expected: required checks and deployment pass; remote development branch is deleted.

- [ ] **Step 3: Back up current runtime state**

Record current unit states and create installer-managed protected backups. Confirm queue is empty or copied before mutation; never print token:

```bash
systemctl --user is-active codex-usage-dashboard-agent.timer || true
systemctl --user is-active codex-usage-dashboard-agent-watch.service || true
systemctl --user is-active codex-usage-dashboard-agent.service || true
```

- [ ] **Step 4: Install and verify one watcher**

Run the reviewed installer with the existing secret in its environment and existing Codex-only paths, then:

```bash
systemctl --user is-active codex-usage-dashboard-agent.service
systemctl --user is-enabled codex-usage-dashboard-agent.service
systemctl --user is-active codex-usage-dashboard-agent.timer || true
systemctl --user is-enabled codex-usage-dashboard-agent.timer || true
systemctl --user is-active codex-usage-dashboard-agent-watch.service || true
systemctl --user is-enabled codex-usage-dashboard-agent-watch.service || true
node apps/agent/dist/cli.js status
```

Expected: main service active/enabled; timer and separate watcher inactive/disabled or absent; status shows version-2 state and startup reconciliation without secrets/paths.

- [ ] **Step 5: Prove ingestion and clean branches**

Record production event count, generate or wait for one genuine new Codex event, confirm exactly-once upload and queue depth zero, and keep rollback artifacts for at least seven days. On failure, execute installer rollback and confirm the previous hourly timer resumes.

```bash
git switch main
git pull --ff-only origin main
git fetch --prune origin
git branch -d codex/watcher-only-agent
git status --short --branch
```

Expected: production ingestion healthy, rollback artifacts outside Git, only `main` remains, and worktree is clean.
