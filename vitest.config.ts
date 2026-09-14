import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          PUBLIC_ORIGIN: 'https://kinetrail.test',
          FITDAYS_HISTORY_START: '2026-06-01T00:00:00+08:00',
          // 以下全部是合成测试值，不是真实凭据。
          CURSOR_SIGNING_KEY: 'test-only-cursor-key-not-a-secret-000000', // SYNTHETIC-SECRET
          FITDAYS_LOGIN: 'synthetic-login-value', // SYNTHETIC-SECRET
          FITDAYS_PASSWORD: 'synthetic-password-value', // SYNTHETIC-SECRET
          FITDAYS_REGION: 'cn',
        },
      },
    })),
  ],
  test: { setupFiles: ['./tests/apply-migrations.ts'] },
})
