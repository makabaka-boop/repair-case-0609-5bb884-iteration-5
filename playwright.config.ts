import { defineConfig, devices } from '@playwright/test';

// E2E 默认对 `vite preview`（构建产物）跑验收；
// 设置 PLAYWRIGHT_BASE_URL（Docker 验收）时改为对已运行的站点测试。
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4173';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    // 容器内默认以 root 运行，Chromium 需要 no-sandbox
    launchOptions: {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    },
    trace: 'on-first-retry'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'npm run build && npm run preview -- --port 4173',
        url: 'http://localhost:4173',
        reuseExistingServer: false,
        timeout: 60_000
      }
});
