import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

export * from "./repositories/guest-account.js";
export * from "./schema.js";

export type GameDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  db: GameDatabase;
  check(): Promise<void>;
  close(): Promise<void>;
}

export function connectDatabase(databaseUrl: string): DatabaseConnection {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    db: drizzle(pool, { schema }),
    async check() {
      await this.db.execute(sql`select 1`);
    },
    async close() {
      await pool.end();
    },
  };
}

export async function migrateDatabase(
  database: GameDatabase,
  migrationsFolder: string,
): Promise<void> {
  await migrate(database, { migrationsFolder });
}
