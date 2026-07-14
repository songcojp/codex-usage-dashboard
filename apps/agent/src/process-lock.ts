import net from "node:net";
import path from "node:path";
import { sha256Hex } from "@codex-usage-dashboard/shared";

export type ProcessLock = { endpoint: string; release(): Promise<void> };

export class AgentAlreadyRunningError extends Error {
  constructor() {
    super("codex usage dashboard agent is already running");
    this.name = "AgentAlreadyRunningError";
  }
}

export async function acquireProcessLock(
  configDir: string,
  platform: NodeJS.Platform | string = process.platform
): Promise<ProcessLock> {
  const id = sha256Hex(path.resolve(configDir)).slice(0, 24);
  const endpoint = platform === "win32"
    ? `\\\\?\\pipe\\codex-usage-dashboard-agent-${id}`
    : platform === "linux"
      ? `\0codex-usage-dashboard-agent-${id}`
      : null;
  if (!endpoint) throw new Error(`unsupported platform for agent process lock: ${platform}`);

  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error.code === "EADDRINUSE" ? new AgentAlreadyRunningError() : error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });

  let released = false;
  return {
    endpoint,
    async release() {
      if (released) return;
      released = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}
