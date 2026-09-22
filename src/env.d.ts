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
  /** Health Connect 推送令牌的 SHA-256（小写十六进制）；未设置时推送入口返回 404。 */
  HC_INGEST_TOKEN_SHA256?: string
  /** 体脂秤网关推送令牌的 SHA-256；未设置时网关入口返回 404。 */
  SCALE_INGEST_TOKEN_SHA256?: string
  /** 仅测试环境：vitest 注入的迁移列表。 */
  TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
}

declare global {
  interface Env extends KinetrailSecrets {}
  namespace Cloudflare {
    interface Env extends KinetrailSecrets {}
  }
}
