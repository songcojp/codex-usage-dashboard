import {
  taskMetadataAcknowledgementSchema,
  type TaskMetadataDraft
} from "@codex-usage-dashboard/shared";
import type { AgentConfig } from "./config.js";
import {
  discoverTaskDatabasePaths,
  parseTaskMetadataDatabase
} from "./task-metadata-database.js";
import {
  discoverTaskIndexPaths,
  parseTaskMetadataIndex
} from "./task-metadata-index.js";
import {
  readTaskMetadataState,
  taskMetadataStatePath,
  writeTaskMetadataState
} from "./task-metadata-state.js";

export type TaskMetadataSyncResult = {
  discovered: number;
  submitted: number;
  acknowledged: number;
  rejected: number;
  malformed: number;
  attempted: boolean;
  status: number | null;
  errorCategory: string | null;
};

export async function syncTaskMetadata(input: {
  config: AgentConfig;
  agentStatePath: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<TaskMetadataSyncResult> {
  const indexPaths = await discoverTaskIndexPaths(input);
  const latest = new Map<string, TaskMetadataDraft>();
  let malformed = 0;
  for (const indexPath of indexPaths) {
    const parsed = await parseTaskMetadataIndex(indexPath);
    malformed += parsed.rejected;
    for (const task of parsed.tasks) {
      mergeLatestTask(latest, task);
    }
  }
  const databasePaths = await discoverTaskDatabasePaths(input);
  for (const databasePath of databasePaths) {
    try {
      const parsed = await parseTaskMetadataDatabase(databasePath);
      malformed += parsed.rejected;
      for (const task of parsed.tasks) {
        mergeLatestTask(latest, lowerPriorityDatabaseRevision(task));
      }
    } catch {
      malformed += 1;
    }
  }

  const statePath = taskMetadataStatePath(input.agentStatePath);
  const state = await readTaskMetadataState(statePath);
  const changed = [...latest.values()]
    .filter((task) => {
      const acknowledged = state.acknowledged[task.taskId];
      return !acknowledged ||
        Date.parse(task.updatedAt) > Date.parse(acknowledged.updatedAt) ||
        (task.updatedAt === acknowledged.updatedAt && task.title !== acknowledged.title);
    })
    .sort((left, right) => left.taskId.localeCompare(right.taskId));

  const result: TaskMetadataSyncResult = {
    discovered: latest.size,
    submitted: 0,
    acknowledged: 0,
    rejected: 0,
    malformed,
    attempted: false,
    status: null,
    errorCategory: null
  };
  const fetchClient = input.fetchImpl ?? fetch;

  for (let offset = 0; offset < changed.length; offset += 1000) {
    const batch = changed.slice(offset, offset + 1000);
    result.attempted = true;
    result.submitted += batch.length;
    let response: Response;
    try {
      response = await fetchClient(new URL("/api/ingest/tasks", input.config.serverUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.config.deviceToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ tasks: batch }),
        signal: input.signal
      });
    } catch {
      result.errorCategory = "task-metadata-upload-failed";
      return result;
    }

    result.status = response.status;
    if (!response.ok) {
      result.errorCategory = "task-metadata-upload-http-failed";
      return result;
    }

    let acknowledgement;
    try {
      acknowledgement = taskMetadataAcknowledgementSchema.parse(await response.json());
    } catch {
      result.errorCategory = "task-metadata-ack-invalid";
      return result;
    }

    const rejectedIds = new Set(acknowledgement.rejected.map(({ taskId }) => taskId));
    for (const task of batch) {
      if (rejectedIds.has(task.taskId)) continue;
      state.acknowledged[task.taskId] = {
        title: task.title,
        updatedAt: task.updatedAt
      };
      result.acknowledged += 1;
    }
    result.rejected += acknowledgement.rejected.length;
    await writeTaskMetadataState(state, statePath);
  }

  return result;
}

function mergeLatestTask(
  latest: Map<string, TaskMetadataDraft>,
  task: TaskMetadataDraft
): void {
  const current = latest.get(task.taskId);
  if (!current || Date.parse(task.updatedAt) > Date.parse(current.updatedAt)) {
    latest.set(task.taskId, task);
  }
}

function lowerPriorityDatabaseRevision(task: TaskMetadataDraft): TaskMetadataDraft {
  return {
    ...task,
    updatedAt: new Date(Date.parse(task.updatedAt) - 1).toISOString()
  };
}
