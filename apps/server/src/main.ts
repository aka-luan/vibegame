import { assertCanonicalContent } from "@gameish/content/canonical";
import { connectDatabase, GuestAccountRepository } from "@gameish/database";

import { parseServerConfig } from "./config.js";
import { startFoundationServer } from "./server.js";
import { GuestAccountService } from "./identity/guest-account.js";
import { DatabasePlayTickets } from "./identity/play-tickets.js";

const config = parseServerConfig(process.env);
await assertCanonicalContent();
const database = connectDatabase(config.DATABASE_URL);
const accountRepository = new GuestAccountRepository(database.db);
const accountService = new GuestAccountService(accountRepository);
const playTickets = new DatabasePlayTickets(accountRepository);
const publicAddress =
  config.PUBLIC_GAME_SERVER_ADDRESS ??
  (config.DEVELOPMENT_LOGIN_ENABLED
    ? `${config.HOST}:${String(config.PORT)}`
    : undefined);
const server = await startFoundationServer({
  host: config.HOST,
  port: config.PORT,
  publicAddress,
  allowedOrigin: config.PUBLIC_ORIGIN,
  readinessProbe: database,
  accountService,
  playTickets,
  developmentLoginEnabled: config.DEVELOPMENT_LOGIN_ENABLED,
  runtimeEnvironment: config.NODE_ENV,
});

server.app.log.info({ port: server.port }, "Foundation server listening");

async function shutdown() {
  await server.close();
  await database.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
