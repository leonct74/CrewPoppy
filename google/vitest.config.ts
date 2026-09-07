import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["backend/src/**/*.test.ts", "frontend/src/**/*.test.ts"] } });
