import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createAdminSessionToken,
  verifyAdminCredentials,
  verifyAdminSessionToken
} from "./auth.js";
import {
  createAdminQueryService,
  generateDeviceToken,
  type AdminQueryService,
  type EventSortBy,
  type ProjectSortBy,
  type SortDir,
  type TaskSortBy,
  type UsageFilters
} from "./queries.js";
import {
  defaultReportingTimeZone,
  isSupportedReportingTimeZone,
  type ReportingTimeZone
} from "../reporting-time.js";
import { LoginRateLimiter } from "./login-rate-limit.js";

const sessionCookieName = "admin_session";

type AdminEnv = {
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  JWT_SECRET?: string;
  NODE_ENV?: string;
  PUBLIC_BASE_URL?: string;
  ADMIN_COOKIE_SECURE?: string;
  TRUST_PROXY?: string;
};

export type RegisterAdminRoutesOptions = {
  adminQueryService?: AdminQueryService;
  env?: AdminEnv;
  loginRateLimiter?: LoginRateLimiter;
};

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: RegisterAdminRoutesOptions = {}
): Promise<void> {
  const queryService = options.adminQueryService ?? createAdminQueryService();
  const env = options.env ?? process.env;
  const loginRateLimiter = options.loginRateLimiter ?? new LoginRateLimiter();

  app.post("/api/admin/login", async (request, reply) => {
    if (loginRateLimiter.isBlocked(request.ip)) {
      return reply.code(429).send({ error: "too many login attempts" });
    }
    const body = parseLoginBody(request.body);
    if (!body || !verifyAdminCredentials(body.email, body.password, env)) {
      loginRateLimiter.recordFailure(request.ip);
      return reply.code(401).send({ error: "invalid credentials" });
    }

    loginRateLimiter.reset(request.ip);

    reply.setCookie(sessionCookieName, createAdminSessionToken(body.email, requireSecret(env)), {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureAdminCookie(env),
      path: "/",
      maxAge: 60 * 60 * 24 * 7
    });

    return { ok: true };
  });

  app.post("/api/admin/logout", async (_request, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  app.get("/api/admin/me", async (request, reply) => {
    const admin = requireAdmin(request, reply, env);
    if (!admin) return;

    return { email: admin.email };
  });

  app.get("/api/admin/summary", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const filters = parseUsageFilters(request.query);
    if (!filters) {
      return reply.code(400).send({ error: "invalid filters" });
    }

    return queryService.getSummary(filters);
  });

  app.get("/api/admin/trends", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const filters = parseUsageFilters(request.query);
    if (!filters) {
      return reply.code(400).send({ error: "invalid filters" });
    }

    return queryService.getTrends(filters);
  });

  app.get("/api/admin/project-ratios", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const filters = parseUsageFilters(request.query);
    if (!filters) {
      return reply.code(400).send({ error: "invalid filters" });
    }

    return queryService.getProjectRatios({ ...filters, projectId: undefined });
  });

  app.get("/api/admin/events", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const filters = parseUsageFilters(request.query);
    if (!filters) {
      return reply.code(400).send({ error: "invalid filters" });
    }
    const query = request.query as Record<string, unknown>;
    const pagination = parsePagination(query);
    const sort = parseEventSort(query);
    if (!pagination || !sort) {
      return reply.code(400).send({ error: "invalid filters" });
    }

    return queryService.getEvents({
      ...filters,
      ...pagination,
      ...sort
    });
  });

  app.get("/api/admin/tasks", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const filters = parseUsageFilters(request.query);
    if (!filters) {
      return reply.code(400).send({ error: "invalid filters" });
    }
    const query = request.query as Record<string, unknown>;
    const pagination = parsePagination(query);
    const sort = parseTaskSort(query);
    if (!pagination || !sort) {
      return reply.code(400).send({ error: "invalid filters" });
    }

    return queryService.getTasks({
      ...filters,
      ...pagination,
      ...sort
    });
  });

  app.get("/api/admin/devices", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const filters = parseOptionalUsageFilters(request.query);
    if (filters === null) {
      return reply.code(400).send({ error: "invalid filters" });
    }

    return queryService.listDevices(filters);
  });

  app.post("/api/admin/devices", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const body = parseCreateDeviceBody(request.body);
    if (!body) {
      return reply.code(400).send({ error: "invalid device" });
    }

    return queryService.createDevice({
      ...body,
      token: generateDeviceToken()
    });
  });

  app.post("/api/admin/devices/:id/disable", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const id = (request.params as { id?: string }).id;
    if (!id) {
      return reply.code(400).send({ error: "invalid device id" });
    }
    if (!isUuid(id)) {
      return reply.code(400).send({ error: "invalid device id" });
    }

    const device = await queryService.disableDevice(id);
    if (!device) {
      return reply.code(404).send({ error: "device not found" });
    }

    return device;
  });

  app.get("/api/admin/projects", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const filters = parseOptionalUsageFilters(request.query);
    if (filters === null) {
      return reply.code(400).send({ error: "invalid filters" });
    }
    const sort = parseProjectSort(request.query as Record<string, unknown>);
    if (!sort) {
      return reply.code(400).send({ error: "invalid filters" });
    }

    return queryService.listProjects({ ...filters, ...sort });
  });

  app.get("/api/admin/models", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const filters = parseUsageFilters(request.query);
    if (!filters) {
      return reply.code(400).send({ error: "invalid filters" });
    }

    return queryService.listModels(filters);
  });

  app.get("/api/admin/tools", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    return queryService.listTools();
  });

  app.get("/api/admin/model-prices", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    return queryService.listModelPrices();
  });

  app.post("/api/admin/model-prices", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const body = parseModelPriceBody(request.body);
    if (!body) {
      return reply.code(400).send({ error: "invalid model price" });
    }

    return queryService.upsertModelPrice(body);
  });

  app.delete("/api/admin/model-prices/:id", async (request, reply) => {
    if (!requireAdmin(request, reply, env)) return;
    const id = (request.params as { id?: string }).id;
    if (!id || !isUuid(id)) {
      return reply.code(400).send({ error: "invalid model price id" });
    }

    const row = await queryService.deleteModelPrice(id);
    if (!row) {
      return reply.code(404).send({ error: "model price not found" });
    }

    return row;
  });
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply, env: AdminEnv) {
  const admin = verifyAdminSessionToken(request.cookies[sessionCookieName], requireSecret(env), {
    adminEmail: env.ADMIN_EMAIL
  });
  if (!admin) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }

  return admin;
}

function clearSession(reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName, { path: "/" });
}

function requireSecret(env: AdminEnv): string {
  if (!env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required");
  }

  return env.JWT_SECRET;
}

function shouldUseSecureAdminCookie(env: AdminEnv): boolean {
  if (env.ADMIN_COOKIE_SECURE === "true") return true;
  if (env.ADMIN_COOKIE_SECURE === "false") return false;

  if (env.PUBLIC_BASE_URL) {
    try {
      return new URL(env.PUBLIC_BASE_URL).protocol === "https:";
    } catch {
      return env.NODE_ENV === "production";
    }
  }

  return env.NODE_ENV === "production";
}

function parseLoginBody(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const { email, password } = body as Record<string, unknown>;
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    email.trim().length === 0 ||
    password.trim().length === 0
  ) {
    return null;
  }

  return { email, password };
}

function parseUsageFilters(query: unknown): UsageFilters | null {
  if (!query || typeof query !== "object") {
    return null;
  }

  const values = query as Record<string, unknown>;
  if (typeof values.from !== "string" || typeof values.to !== "string") {
    return null;
  }

  const from = parseDateOnly(values.from);
  const to = parseDateOnly(values.to);
  if (!from || !to || from.getTime() > to.getTime()) {
    return null;
  }
  const deviceId = optionalString(values.deviceId);
  const projectId = optionalString(values.projectId);
  if ((deviceId && !isUuid(deviceId)) || (projectId && !isUuid(projectId))) {
    return null;
  }
  const timeZone = parseReportingTimeZone(values.timeZone);
  if (!timeZone) {
    return null;
  }

  return {
    from: values.from,
    to: values.to,
    tool: optionalString(values.tool),
    deviceId,
    projectId,
    model: optionalString(values.model),
    timeZone
  };
}

function parseOptionalUsageFilters(query: unknown): UsageFilters | undefined | null {
  if (!query || typeof query !== "object") {
    return undefined;
  }

  const values = query as Record<string, unknown>;
  const hasFilter = ["from", "to", "tool", "deviceId", "projectId", "model"].some(
    (key) => values[key] !== undefined
  );
  if (!hasFilter) {
    return undefined;
  }

  return parseUsageFilters(query);
}

function parseCreateDeviceBody(body: unknown) {
  if (!body || typeof body !== "object") {
    return null;
  }

  const values = body as Record<string, unknown>;
  if (typeof values.name !== "string" || typeof values.os !== "string") {
    return null;
  }
  const name = values.name.trim();
  const os = values.os.trim();
  if (!name || !os) {
    return null;
  }

  return {
    name,
    os,
    hostnameHash: optionalString(values.hostnameHash) ?? ""
  };
}

function parseModelPriceBody(body: unknown) {
  if (!body || typeof body !== "object") {
    return null;
  }

  const values = body as Record<string, unknown>;
  const model = stringField(values.model);
  const inputCostPerMillionUsd = nonNegativeNumber(values.inputCostPerMillionUsd);
  const outputCostPerMillionUsd = nonNegativeNumber(values.outputCostPerMillionUsd);
  const cacheReadCostPerMillionUsd = nonNegativeNumber(values.cacheReadCostPerMillionUsd);
  const cacheWriteCostPerMillionUsd = nonNegativeNumber(values.cacheWriteCostPerMillionUsd);

  if (
    !model ||
    inputCostPerMillionUsd === null ||
    outputCostPerMillionUsd === null ||
    cacheReadCostPerMillionUsd === null ||
    cacheWriteCostPerMillionUsd === null
  ) {
    return null;
  }

  return {
    model,
    inputCostPerMillionUsd,
    outputCostPerMillionUsd,
    cacheReadCostPerMillionUsd,
    cacheWriteCostPerMillionUsd
  };
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseReportingTimeZone(value: unknown): ReportingTimeZone | null {
  if (value === undefined) {
    return defaultReportingTimeZone;
  }
  return typeof value === "string" && isSupportedReportingTimeZone(value) ? value : null;
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parsePagination(query: Record<string, unknown>): { limit?: number; offset?: number } | null {
  const limit = parseOptionalInteger(query.limit);
  const offset = parseOptionalInteger(query.offset);

  if (
    (query.limit !== undefined && (limit === undefined || limit < 1)) ||
    (query.offset !== undefined && (offset === undefined || offset < 0))
  ) {
    return null;
  }

  return { limit, offset };
}

function parseEventSort(query: Record<string, unknown>): { sortBy?: EventSortBy; sortDir?: SortDir } | null {
  const sortBy = optionalString(query.sortBy);
  const sortDir = optionalString(query.sortDir);

  if (sortBy && !isEventSortBy(sortBy)) {
    return null;
  }
  if (sortDir && !isSortDir(sortDir)) {
    return null;
  }

  return {
    sortBy: sortBy ? (sortBy as EventSortBy) : undefined,
    sortDir: sortDir ? (sortDir as SortDir) : undefined
  };
}

function isEventSortBy(value: string): value is EventSortBy {
  return ["occurredAt", "totalTokens", "inputTokens", "outputTokens", "cacheTokens", "costUsd"].includes(value);
}

function parseTaskSort(query: Record<string, unknown>): { sortBy?: TaskSortBy; sortDir?: SortDir } | null {
  const sortBy = optionalString(query.sortBy);
  const sortDir = optionalString(query.sortDir);

  if (sortBy && !isTaskSortBy(sortBy)) {
    return null;
  }
  if (sortDir && !isSortDir(sortDir)) {
    return null;
  }

  return {
    sortBy: sortBy ? (sortBy as TaskSortBy) : undefined,
    sortDir: sortDir ? (sortDir as SortDir) : undefined
  };
}

function isTaskSortBy(value: string): value is TaskSortBy {
  return ["lastActivityAt", "eventCount", "totalTokens", "costUsd"].includes(value);
}

function parseProjectSort(query: Record<string, unknown>): { sortBy?: ProjectSortBy; sortDir?: SortDir } | null {
  const sortBy = optionalString(query.sortBy);
  const sortDir = optionalString(query.sortDir);

  if (sortBy && !isProjectSortBy(sortBy)) {
    return null;
  }
  if (sortDir && !isSortDir(sortDir)) {
    return null;
  }

  return {
    sortBy: sortBy ? (sortBy as ProjectSortBy) : undefined,
    sortDir: sortDir ? (sortDir as SortDir) : undefined
  };
}

function isProjectSortBy(value: string): value is ProjectSortBy {
  return ["eventCount", "totalTokens", "costUsd", "updatedAt"].includes(value);
}

function isSortDir(value: string): value is SortDir {
  return value === "asc" || value === "desc";
}

function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return null;
  }

  return date;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}
