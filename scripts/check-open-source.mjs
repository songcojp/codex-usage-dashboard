import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const excludedNames = new Set([".git", "node_modules", "dist", "build", "coverage", ".cache", ".codegraph"]);
const legacyId = ["token", "-report"].join("");
const removedIntegration = ["anti", "gravity"].join("");
const rules = [
  ["PRIVATE_KEY", new RegExp(["-----BEGIN ", "(?:(?:RSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----"].join(""), "i")],
  ["PROVIDER_TOKEN", new RegExp([
    "(?:(?:gh", "p_|github_pat_)[A-Za-z0-9_]{20,}|",
    "(?<![A-Za-z0-9])s", "k-[A-Za-z0-9_-]{20,}|",
    "xo", "x[baprs]-[A-Za-z0-9-]{20,}|",
    "AK", "IA[0-9A-Z]{16})"
  ].join(""))],
  ["CREDENTIAL_URL", /https?:\/\/[^\s/@:]+:[^\s/@]+@/i],
  ["PERSONAL_PATH", /(?:\/(?:home|Users)\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/],
  ["LEGACY_ID", new RegExp(legacyId, "i")],
  ["REMOVED_INTEGRATION", new RegExp(removedIntegration, "i")]
];

export async function scanOpenSourceTree(root) {
  const findings = [];
  for (const file of await listFiles(root)) {
    let content;
    try { content = await readFile(file, "utf8"); } catch { continue; }
    const relative = path.relative(root, file).split(path.sep).join("/");
    for (const [category, pattern] of rules) {
      if (pattern.test(content)) findings.push({ category, file: relative });
    }
    if (containsPublicIpv4(content)) findings.push({ category: "PUBLIC_IP", file: relative });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.category.localeCompare(b.category));
}

async function listFiles(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excludedNames.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) result.push(target);
    }
  }
  await walk(root);
  return result;
}

function containsPublicIpv4(content) {
  for (const match of content.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) {
    const parts = match[1].split(".").map(Number);
    if (parts.some((part) => part > 255) || isAllowedAddress(parts)) continue;
    return true;
  }
  return false;
}

function isAllowedAddress([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = await scanOpenSourceTree(process.argv[2] ? path.resolve(process.argv[2]) : process.cwd());
  for (const finding of findings) console.error(`[${finding.category}] ${finding.file}`);
  if (findings.length > 0) process.exitCode = 1;
}
