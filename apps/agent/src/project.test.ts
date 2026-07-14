import { describe, expect, it } from "vitest";
import { identityFromPathParts } from "./project.js";

describe("identityFromPathParts", () => {
  it("does not expose full paths", () => {
    const identity = identityFromPathParts({
      cwd: "/workspace/projects/example",
      gitRemote: "git@github.com:example/example.git"
    });

    expect(identity.displayName).toBe("example");
    expect(identity.repoHash).toHaveLength(64);
    expect(identity.remoteHash).toHaveLength(64);
    expect(identity.pathHash).toHaveLength(64);
    expect(JSON.stringify(identity)).not.toContain("/workspace/projects/example");
  });

  it("uses null remote hash when no git remote is present", () => {
    const identity = identityFromPathParts({ cwd: "/tmp/local-only" });

    expect(identity.displayName).toBe("local-only");
    expect(identity.remoteHash).toBeNull();
  });

  it("does not expose Windows-style full paths on non-Windows runtimes", () => {
    const identity = identityFromPathParts({
      cwd: "C:\\workspace\\projects\\example"
    });

    expect(identity.displayName).toBe("example");
    expect(JSON.stringify(identity)).not.toContain("C:\\workspace\\projects\\example");
  });

  it("uses normalized git remote identity across local clone paths", () => {
    const first = identityFromPathParts({
      cwd: "/workspace/projects/example",
      gitRemote: "git@github.com:owner/example.git"
    });
    const second = identityFromPathParts({
      cwd: "/tmp/worktrees/example",
      gitRemote: "https://github.com/owner/example"
    });

    expect(first.displayName).toBe("example");
    expect(second.displayName).toBe("example");
    expect(first.remoteHash).toBe(second.remoteHash);
    expect(first.pathHash).toBe(second.pathHash);
  });

  it("keeps forked git remotes distinct", () => {
    const upstream = identityFromPathParts({
      cwd: "/workspace/example",
      gitRemote: "https://github.com/upstream/example.git"
    });
    const fork = identityFromPathParts({
      cwd: "/workspace/example",
      gitRemote: "https://github.com/fork/example.git"
    });

    expect(upstream.displayName).toBe("example");
    expect(fork.displayName).toBe("example");
    expect(upstream.repoHash).toBe(fork.repoHash);
    expect(upstream.remoteHash).not.toBe(fork.remoteHash);
    expect(upstream.pathHash).not.toBe(fork.pathHash);
  });
});
