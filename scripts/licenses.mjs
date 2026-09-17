// 由生产依赖闭包（npm ls --omit=dev）生成 THIRD_PARTY_NOTICES.md。依赖或 lockfile 变化后重跑并提交。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tree = JSON.parse(
  execFileSync(npm, ['ls', '--omit=dev', '--all', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }),
)
const packages = new Map()
const walk = (deps = {}) => {
  for (const [name, info] of Object.entries(deps)) {
    packages.set(`${name}@${info.version}`, name)
    walk(info.dependencies)
  }
}
walk(tree.dependencies)

const sections = [...packages].sort().map(([id, name]) => {
  const dir = join('node_modules', name)
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const licenseFile = existsSync(dir)
    ? readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)/i.test(f))
    : undefined
  const author = typeof meta.author === 'string' ? meta.author : meta.author?.name
  const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url
  const body = licenseFile
    ? readFileSync(join(dir, licenseFile), 'utf8').trim()
    : `发布包未附带许可证文件；package.json 声明 ${meta.license}${author ? `，作者：${author}` : ''}${repo ? `，源码：${repo}` : ''}。`
  return `## ${id}\n\n- 许可证：${meta.license}\n\n\`\`\`text\n${body}\n\`\`\``
})

writeFileSync(
  'THIRD_PARTY_NOTICES.md',
  `# 第三方许可证\n\n由 \`node scripts/licenses.mjs\` 根据生产依赖闭包生成，只包含会打进 Worker 的运行时依赖。开发工具（wrangler、vitest、biome、typescript）不随产物分发。Android App 用到的图标声明见 \`android/THIRD_PARTY_NOTICES.md\`。\n\n${sections.join('\n\n')}\n`,
)
console.log(`THIRD_PARTY_NOTICES.md: ${packages.size} packages`)
