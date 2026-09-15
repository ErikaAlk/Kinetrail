import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          PUBLIC_ORIGIN: 'https://kinetrail.test',
          FITDAYS_HISTORY_START: '2026-06-01T00:00:00+08:00',
          // 测试默认保留全部成员；白名单行为在 measurements.test.ts 里单独覆盖。
          PROFILE_ALLOWLIST: '',
          // 以下全部是合成测试值，不是真实凭据。
          CURSOR_SIGNING_KEY: 'test-only-cursor-key-not-a-secret-000000', // SYNTHETIC-SECRET
          FITDAYS_LOGIN: 'synthetic-login-value', // SYNTHETIC-SECRET
          FITDAYS_PASSWORD: 'synthetic-password-value', // SYNTHETIC-SECRET
          FITDAYS_REGION: 'cn',
        },
      },
    })),
  ],
  // .claude/worktrees 下是 Claude Code 在仓库内建的 worktree 副本，不重复跑它们的测试。
  test: {
    setupFiles: ['./tests/apply-migrations.ts'],
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
  },
})
