import { serve } from "@hono/node-server";
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8787);
const app = createApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`carrier-bff listening on http://localhost:${info.port}`);
});
