import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

// wrangler types 只生成 wrangler.jsonc 中的 vars/bindings；Secret 与运行时注入项在这里声明。
interface KinetrailSecrets {
  /** OAuth Provider 在进入 apiHandler/defaultHandler 前注入。 */
  OAUTH_PROVIDER: OAuthHelpers
  FITDAYS_LOGIN?: string
  FITDAYS_PASSWORD?: string
  FITDAYS_REGION?: string
  ACCESS_CLIENT_SECRET?: string
  CURSOR_SIGNING_KEY?: string
  /** 仅测试环境：vitest 注入的迁移列表。 */
  TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
}

declare global {
  interface Env extends KinetrailSecrets {}
  namespace Cloudflare {
    interface Env extends KinetrailSecrets {}
  }
}
