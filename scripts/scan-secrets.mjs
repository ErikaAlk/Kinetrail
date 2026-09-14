// 仓库秘密扫描：提交前与 npm run check 中运行。命中即非零退出，只打印文件与规则名，不打印命中值。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', '.local', 'dist'])
const TEXT = /\.(ts|mjs|js|json|jsonc|md|sql|py|txt|toml|yaml|yml|html)$|^\.(gitignore|npmrc)$/
const FORBIDDEN_FILES = /^\.(dev\.vars|env)(\..*)?$/

const RULES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer-token', /Bearer\s+[A-Za-z0-9._~+/-]{24,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'secret-assignment',
    /\b(FITDAYS_PASSWORD|FITDAYS_LOGIN|ACCESS_CLIENT_SECRET|CURSOR_SIGNING_KEY)\s*[=:]\s*["']?(?!["'<]|\$|\s|process|env|undefined)[^\s"',]{6,}/,
  ],
  [
    'json-credential',
    /"(token|refresh_token|access_token|password|email|phone|open_id)"\s*:\s*"(?!synthetic|fixture|\s*")[^"]{4,}"/i,
  ],
  ['signed-url', /https?:\/\/[^\s"']*[?&](token|sign|signature)=[A-Za-z0-9]{8,}/i],
]
// 测试里刻意构造的合成秘密样本带这个标记，只在测试文件生效。
const SYNTHETIC_MARK = /SYNTHETIC-SECRET/

const hits = []
function visit(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const rel = relative(ROOT, path).replaceAll('\\', '/')
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) visit(path)
      continue
    }
    if (FORBIDDEN_FILES.test(name)) hits.push(`${rel}: forbidden-file`)
    if (!TEXT.test(name)) continue
    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      if ((rel.startsWith('tests/') || rel === 'vitest.config.ts') && SYNTHETIC_MARK.test(line)) return
      if (rel === 'scripts/scan-secrets.mjs') return
      for (const [rule, re] of RULES) if (re.test(line)) hits.push(`${rel}:${i + 1}: ${rule}`)
    })
  }
}
visit(ROOT)
if (hits.length) {
  console.error(`secret scan failed (${hits.length}):\n${hits.join('\n')}`)
  process.exit(1)
}
console.log('secret scan passed')
