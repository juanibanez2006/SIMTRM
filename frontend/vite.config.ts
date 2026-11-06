import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: `http://127.0.0.1:${mode === "e2e" ? 8001 : 8000}` },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: false,
    include: ["src/test/**/*.test.{ts,tsx}"],
  },
}));
