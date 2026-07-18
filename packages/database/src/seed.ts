import { connectDatabase } from "./index.js";
import { seedInitialState } from "./repositories/guest-account.js";

const database = connectDatabase(
  process.env.DATABASE_URL ??
    "postgres://gameish:gameish@localhost:5432/gameish",
);

try {
  await seedInitialState(database.db);
} finally {
  await database.close();
}
