import { serve } from "@hono/node-server";
import { createApp, createDeps } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const deps = await createDeps({ config });
const app = createApp(deps);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`carrier-bff listening on http://localhost:${info.port}`);
});
