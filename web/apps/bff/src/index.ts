import { serve } from "@hono/node-server";
import { createApp, createDeps } from "./app.js";
import { loadConfig } from "./config.js";
import { seedDevUser } from "./auth/index.js";

const config = loadConfig();
const deps = await createDeps({ config });
const app = createApp(deps);

if (config.seedDevUser) {
  await seedDevUser(deps.db, config);
  console.log(
    `carrier-bff dev login: ${config.devUserEmail} / ${config.devUserPassword}`,
  );
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`carrier-bff listening on http://localhost:${info.port}`);
});
