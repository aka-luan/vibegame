import { defineConfig, devices } from "@playwright/test";

const runAccountE2E = process.env.RUN_ACCOUNT_E2E === "true";
const accountMigration = runAccountE2E ? "pnpm db:migrate && " : "";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:55173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `${accountMigration}pnpm --filter @gameish/content build && pnpm --filter @gameish/world build && pnpm --filter @gameish/protocol build && pnpm --filter @gameish/database build && pnpm --filter @gameish/server build && DEVELOPMENT_LOGIN_ENABLED=true PUBLIC_ORIGIN=http://127.0.0.1:55173 NODE_ENV=test PORT=3567 pnpm --filter @gameish/server start`,
      url: "http://127.0.0.1:3567/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "pnpm --filter @gameish/content build && pnpm --filter @gameish/world build && pnpm --filter @gameish/protocol build && GAME_SERVER_PORT=3567 VITE_DEVELOPMENT_LOGIN_ENABLED=true pnpm --filter @gameish/web exec vite build --mode test && GAME_SERVER_PORT=3567 pnpm --filter @gameish/web preview --host 127.0.0.1 --port 55173",
      url: "http://127.0.0.1:55173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
