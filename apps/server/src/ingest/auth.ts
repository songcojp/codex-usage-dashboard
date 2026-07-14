import { hashToken, sha256Hex } from "@codex-usage-dashboard/shared";

const bearerPrefix = "Bearer ";
const legacyDeviceTokenNamespace = ["token", "-report-device-token:"].join("");

export function readBearerToken(header: string | undefined): string {
  if (!header?.startsWith(bearerPrefix)) {
    throw new Error("missing bearer token");
  }

  const token = header.slice(bearerPrefix.length).trim();
  if (token.length === 0) {
    throw new Error("missing bearer token");
  }

  return token;
}

export function hashBearerToken(header: string | undefined): string {
  return hashBearerTokenCandidates(header)[0];
}

export function hashBearerTokenCandidates(header: string | undefined): [string, string] {
  const token = readBearerToken(header);
  return [hashToken(token), sha256Hex(`${legacyDeviceTokenNamespace}${token}`)];
}
