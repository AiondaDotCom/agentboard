import { defineConfig } from '@playwright/test';

const E2E_PORT = 3099;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    headless: true,
    channel: 'chrome',
  },
  webServer: {
    command: `PORT=${E2E_PORT} DB_PATH=agentboard-e2e.db tsx src/server.ts`,
    port: E2E_PORT,
    reuseExistingServer: !process.env['CI'],
  },
});
