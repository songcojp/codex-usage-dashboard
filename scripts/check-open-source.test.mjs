import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scanOpenSourceTree } from "./check-open-source.mjs";

const cases = [
  ["PRIVATE_KEY", ["-----BEGIN ", "PRIVATE KEY-----"].join("")],
  ["PROVIDER_TOKEN", ["gh", "p_abcdefghijklmnopqrstuvwxyz1234567890"].join("")],
  ["CREDENTIAL_URL", ["https://user:", "password@dashboard.example.com"].join("")],
  ["PERSONAL_PATH", ["/ho", "me/alice/private"].join("")],
  ["PUBLIC_IP", ["8", ".8.8.8"].join("")],
  ["LEGACY_ID", ["token", "-report"].join("")],
  ["REMOVED_INTEGRATION", ["anti", "gravity"].join("")]
];

for (const [category, content] of cases) {
  test(`detects ${category} without returning matched content`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cud-scan-"));
    try {
      await writeFile(path.join(dir, "sample.txt"), content);
      const findings = await scanOpenSourceTree(dir);
      assert.deepEqual(findings, [{ category, file: "sample.txt" }]);
      assert.doesNotMatch(JSON.stringify(findings), new RegExp(escapeRegex(content)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("accepts placeholders, GitHub expressions, loopback, private, and documentation addresses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cud-scan-clean-"));
  try {
    await writeFile(path.join(dir, "sample.txt"), [
      "https://dashboard.example.com",
      "${{ secrets.DEPLOY_HOST }}",
      "127.0.0.1 10.0.0.1 192.168.1.1 203.0.113.10",
      "replace-with-a-secret"
    ].join("\n"));
    assert.deepEqual(await scanOpenSourceTree(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("accepts a public CA certificate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cud-scan-certificate-"));
  try {
    await writeFile(path.join(dir, "root.crt"), [
      "-----BEGIN CERTIFICATE-----",
      "MIIBpublictrustmaterialonly",
      "-----END CERTIFICATE-----"
    ].join("\n"));
    assert.deepEqual(await scanOpenSourceTree(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not mistake task-metadata module names for provider tokens", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cud-scan-task-name-"));
  try {
    await writeFile(path.join(dir, "sample.txt"), [
      "./task-metadata-sync.js",
      "./task-metadata-state.js",
      "task-metadata-upload-http-failed"
    ].join("\n"));
    assert.deepEqual(await scanOpenSourceTree(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
