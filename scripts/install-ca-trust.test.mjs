import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const linuxScript = path.join(repoRoot, "scripts", "install-ca-trust.sh");
const windowsScript = path.join(repoRoot, "scripts", "install-ca-trust-windows.ps1");

function runLinux(backend, extraEnv = {}) {
  return spawnSync("bash", [linuxScript, "--dry-run"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_USAGE_DASHBOARD_TEST_CA_BACKEND: backend,
      ...extraEnv
    },
    encoding: "utf8"
  });
}

test("Linux trust installer previews Debian-family system trust installation", () => {
  const result = runLinux("debian");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/usr\/local\/share\/ca-certificates\/codex-usage-dashboard\.crt/);
  assert.match(result.stdout, /update-ca-certificates/);
  assert.match(result.stdout, /restart.*browser/i);
  assert.doesNotMatch(result.stdout, /device token|systemd|agent service/i);
});

test("Linux trust installer is independent of Node and cannot replace the committed CA", async () => {
  const source = await readFile(linuxScript, "utf8");

  assert.match(source, /command -v openssl/);
  assert.doesNotMatch(source, /CODEX_USAGE_DASHBOARD_CA_CERT|command -v node/);
});

test("Linux trust installer previews RHEL-family system trust installation", () => {
  const result = runLinux("rhel");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/etc\/pki\/ca-trust\/source\/anchors\/codex-usage-dashboard\.crt/);
  assert.match(result.stdout, /update-ca-trust/);
});

test("Linux trust installer rejects a missing CA certificate", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ca-trust-missing-"));
  const tempScript = path.join(tempRoot, "scripts", "install-ca-trust.sh");
  mkdirSync(path.dirname(tempScript), { recursive: true });
  copyFileSync(linuxScript, tempScript);
  const result = spawnSync("bash", [tempScript, "--dry-run"], {
    env: { ...process.env, CODEX_USAGE_DASHBOARD_TEST_CA_BACKEND: "debian" },
    encoding: "utf8"
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /CA certificate is missing/i);
});

test("Linux trust installer rejects any private-key material beside the CA", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ca-trust-key-"));
  const tempScript = path.join(tempRoot, "scripts", "install-ca-trust.sh");
  const tempCert = path.join(tempRoot, "deploy", "certs", "caddy-root.crt");
  mkdirSync(path.dirname(tempScript), { recursive: true });
  mkdirSync(path.dirname(tempCert), { recursive: true });
  copyFileSync(linuxScript, tempScript);
  copyFileSync(path.join(repoRoot, "deploy", "certs", "caddy-root.crt"), tempCert);
  writeFileSync(tempCert, `${readFileSync(tempCert, "utf8")}\n-----BEGIN DSA PRIVATE KEY-----\nAAAA\n-----END DSA PRIVATE KEY-----\n`);

  const result = spawnSync("bash", [tempScript, "--dry-run"], {
    env: { ...process.env, CODEX_USAGE_DASHBOARD_TEST_CA_BACKEND: "debian" },
    encoding: "utf8"
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid/i);
});

test("Windows trust installer targets only the current-user OS trust store", async () => {
  assert.equal(existsSync(windowsScript), true, "Windows trust installer must exist");
  const source = await readFile(windowsScript, "utf8");

  assert.match(source, /Cert:\\CurrentUser\\Root/);
  assert.match(source, /Import-Certificate/);
  assert.match(source, /ValidateOnly/);
  assert.match(source, /\.Thumbprint/);
  assert.match(source, /X509Certificate2/);
  assert.doesNotMatch(source, /fingerprint256|CODEX_USAGE_DASHBOARD_CA_CERT|Get-Command node|Cert:\\LocalMachine|Firefox|deviceToken|schtasks|systemd/i);
});

test("README documents standalone OS trust installation", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /scripts\/install-ca-trust\.sh/);
  assert.match(readme, /scripts[\\\\/]install-ca-trust-windows\.ps1/);
  assert.match(readme, /operating-system trust store/i);
  assert.match(readme, /do(?:es)? not modify.*agent/i);
});
