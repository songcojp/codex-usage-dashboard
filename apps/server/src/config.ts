export type ServerEnv = NodeJS.ProcessEnv & {
  NODE_ENV?: string;
  PUBLIC_BASE_URL?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  JWT_SECRET?: string;
  TRUST_PROXY?: string;
};

export function validateServerConfig(env: ServerEnv): void {
  if (env.NODE_ENV !== "production") return;

  requireNonBlank(env.ADMIN_EMAIL, "ADMIN_EMAIL");
  requireNonBlank(env.ADMIN_PASSWORD, "ADMIN_PASSWORD");
  const secret = requireNonBlank(env.JWT_SECRET, "JWT_SECRET");
  if (secret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");

  const publicBaseUrl = requireNonBlank(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL");
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use https in production");
}

function requireNonBlank(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required in production`);
  return value.trim();
}
