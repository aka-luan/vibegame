import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export interface DatabaseConnection {
  db: NodePgDatabase;
  check(): Promise<void>;
  close(): Promise<void>;
}

export function connectDatabase(databaseUrl: string): DatabaseConnection {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    db: drizzle(pool),
    async check() {
      await this.db.execute(sql`select 1`);
    },
    async close() {
      await pool.end();
    },
  };
}
