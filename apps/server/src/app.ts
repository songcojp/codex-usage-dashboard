import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAdminRoutes, type RegisterAdminRoutesOptions } from "./admin/routes.js";
import { registerIngestRoutes, type RegisterIngestRoutesOptions } from "./ingest/routes.js";

export type BuildAppOptions = RegisterIngestRoutesOptions & RegisterAdminRoutesOptions;

export async function buildApp(options: BuildAppOptions = {}) {
  const env = options.env ?? process.env;
  const trustProxy = env.TRUST_PROXY?.trim();
  const app = Fastify({
    logger: true,
    trustProxy: trustProxy ? trustProxy.split(",").map((value) => value.trim()).filter(Boolean) : false
  });

  await app.register(cookie);

  app.get("/api/health", async () => ({ ok: true }));
  await registerIngestRoutes(app, options);
  await registerAdminRoutes(app, options);
  await app.register(fastifyStatic, {
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public"),
    prefix: "/"
  });

  return app;
}
