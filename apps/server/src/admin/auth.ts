import { createHmac, timingSafeEqual } from "node:crypto";

type AdminEnv = {
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
};

const sessionVersion = "v1";
const defaultSessionMaxAgeSeconds = 60 * 60 * 24 * 7;

type SessionClockOptions = {
  now?: Date;
  maxAgeSeconds?: number;
};

type VerifySessionOptions = SessionClockOptions & {
  adminEmail?: string;
};

export function verifyAdminCredentials(
  email: string,
  password: string,
  env: AdminEnv = process.env
): boolean {
  if (
    !isNonBlank(email) ||
    !isNonBlank(password) ||
    !isNonBlank(env.ADMIN_EMAIL) ||
    !isNonBlank(env.ADMIN_PASSWORD)
  ) {
    return false;
  }

  return email === env.ADMIN_EMAIL && password === env.ADMIN_PASSWORD;
}

export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required");
  return secret;
}

export function createAdminSessionToken(
  email: string,
  secret = requireJwtSecret(),
  options: SessionClockOptions = {}
): string {
  const issuedAt = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      v: sessionVersion,
      email,
      iat: issuedAt,
      exp: issuedAt + (options.maxAgeSeconds ?? defaultSessionMaxAgeSeconds)
    })
  ).toString("base64url");
  const signature = sign(payload, secret);

  return `${payload}.${signature}`;
}

export function verifyAdminSessionToken(
  token: string | undefined,
  secret = requireJwtSecret(),
  options: VerifySessionOptions = {}
) {
  if (!token) {
    return null;
  }

  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) {
    return null;
  }

  if (!constantTimeEquals(signature, sign(payload, secret))) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: string;
      email?: unknown;
      iat?: unknown;
      exp?: unknown;
    };

    if (
      parsed.v !== sessionVersion ||
      typeof parsed.email !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }

    if (
      "adminEmail" in options &&
      (!isNonBlank(options.adminEmail) || parsed.email !== options.adminEmail)
    ) {
      return null;
    }

    const now = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
    const maxAgeSeconds = options.maxAgeSeconds ?? defaultSessionMaxAgeSeconds;
    if (parsed.exp <= now || parsed.iat + maxAgeSeconds <= now) {
      return null;
    }

    return { email: parsed.email };
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isNonBlank(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
