import { hashToken } from "@codex-usage-dashboard/shared";

const bearerPrefix = "Bearer ";

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
  return hashToken(readBearerToken(header));
}
