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
          CURSOR_SIGNING_KEY: 'test-only-cursor-key-not-a-secret-000000', // SYNTHETIC-SECRET
        },
      },
    })),
  ],
  test: { setupFiles: ['./tests/apply-migrations.ts'] },
})
