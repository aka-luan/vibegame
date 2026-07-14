import { assertCanonicalContent } from "@gameish/content/canonical";
import { connectDatabase } from "@gameish/database";

import { parseServerConfig } from "./config.js";
import { startFoundationServer } from "./server.js";

const config = parseServerConfig(process.env);
await assertCanonicalContent();
const database = connectDatabase(config.DATABASE_URL);
const server = await startFoundationServer({
  host: config.HOST,
  port: config.PORT,
  readinessProbe: database,
});

server.app.log.info({ port: server.port }, "Foundation server listening");

async function shutdown() {
  await server.close();
  await database.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
