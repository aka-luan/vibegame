import { assertCanonicalContent } from "@gameish/content/canonical";
import {
  connectDatabase,
  DurableStateRepository,
  GuestAccountRepository,
} from "@gameish/database";

import { parseServerConfig } from "./config.js";
import { startFoundationServer } from "./server.js";
import { GuestAccountService } from "./identity/guest-account.js";
import { DatabasePlayTickets } from "./identity/play-tickets.js";
import { PostgresTransitionTicketIssuer } from "./identity/transition-tickets.js";
import {
  PostgresQuestPersistence,
  PostgresRewardPersistence,
} from "./persistence/durable-state.js";
import { PostgresEquipmentPersistence } from "./equipment/persistence.js";

const config = parseServerConfig(process.env);
await assertCanonicalContent();
const database = connectDatabase(config.DATABASE_URL);
const accountRepository = new GuestAccountRepository(database.db);
const durableState = new DurableStateRepository(database.db);
const accountService = new GuestAccountService(accountRepository);
const playTickets = new DatabasePlayTickets(accountRepository);
const transitionTickets = new PostgresTransitionTicketIssuer(accountRepository);
const questPersistence = new PostgresQuestPersistence(durableState);
const rewardPersistence = new PostgresRewardPersistence(durableState);
const equipmentPersistence = new PostgresEquipmentPersistence(durableState);
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
  transitionTickets,
  questPersistence,
  rewardPersistence,
  equipmentPersistence,
  checkpointLocation: (input) => durableState.checkpointLocation(input),
  developmentLoginEnabled: config.DEVELOPMENT_LOGIN_ENABLED,
  developmentInstanceInspectionEnabled:
    config.DEVELOPMENT_INSTANCE_INSPECTION_ENABLED,
  softPopulationTarget: config.MAP_INSTANCE_SOFT_POPULATION_TARGET,
  hardCapacity: config.MAP_INSTANCE_HARD_CAPACITY,
  mapChatEnabled: config.CONTROLLED_MAP_CHAT_ENABLED,
  runtimeEnvironment: config.NODE_ENV,
});

server.app.log.info({ port: server.port }, "Foundation server listening");

async function shutdown() {
  await server.close();
  await database.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
