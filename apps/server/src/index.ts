import { buildApp } from "./app.js";
import { validateServerConfig } from "./config.js";

validateServerConfig(process.env);
const app = await buildApp();
const port = Number(process.env.PORT ?? 3000);

await app.listen({ host: "0.0.0.0", port });
