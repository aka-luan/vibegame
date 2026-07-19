import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gameServerTarget = `http://127.0.0.1:${process.env.GAME_SERVER_PORT ?? "2567"}`;
const gameServerProxy = { target: gameServerTarget };
const gameServerWebSocketProxy = { target: gameServerTarget, ws: true };

const proxy = {
  "/api": gameServerProxy,
  "/development": gameServerProxy,
  "/matchmake": gameServerProxy,
  "^/[A-Za-z0-9_-]{8,}/[A-Za-z0-9_-]{8,}(?:\\?.*)?$": gameServerWebSocketProxy,
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy,
    strictPort: true,
  },
  preview: {
    proxy,
  },
});
