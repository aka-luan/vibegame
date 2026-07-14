import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gameServerTarget = `http://127.0.0.1:${process.env.GAME_SERVER_PORT ?? "2567"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/development": gameServerTarget,
      "/matchmake": gameServerTarget,
    },
    strictPort: true,
  },
  preview: {
    proxy: {
      "/development": gameServerTarget,
      "/matchmake": gameServerTarget,
    },
  },
});
