// 加密导出 D1：wrangler d1 export → AES-256-GCM 加密 → RSA-OAEP-SHA256 包裹数据密钥（只需公钥）。
// 明文 SQL 只在临时目录停留，加密后覆写并删除。解密私钥不应放在运行本脚本或 Worker 的环境里。
//
// node scripts/backup.mjs --public-key backup-public.pem --out D:\kinetrail-backups [--database kinetrail]
//   [--local]  从 wrangler dev 的本地库导出（恢复演练用）
//   [--prune]  按保留策略删除旧备份：最近 30 个日备份 + 每月最后一个（保留 12 个月）
import { execFileSync } from 'node:child_process'
import {
  constants,
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from 'node:crypto'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    'public-key': { type: 'string' },
    out: { type: 'string' },
    database: { type: 'string', default: 'kinetrail' },
    local: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
  },
})
if (!values['public-key'] || !values.out) {
  console.error(
    'usage: node scripts/backup.mjs --public-key <pem> --out <dir> [--database kinetrail] [--local] [--prune]',
  )
  process.exit(2)
}

const publicKey = createPublicKey(readFileSync(values['public-key']))
if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 3072) {
  console.error('public key must be RSA >= 3072 bits')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'kinetrail-backup-'))
const plainPath = join(work, 'export.sql')
try {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const location = values.local ? '--local' : '--remote'
  execFileSync(
    npx,
    ['wrangler', 'd1', 'export', values.database, location, '--output', plainPath, '--skip-confirmation'],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
    },
  )
  const plain = readFileSync(plainPath)
  const dataKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  const header = {
    format: 'kinetrail-backup-v1',
    created_at: new Date().toISOString(),
    database: values.database,
    source: values.local ? 'local' : 'remote',
    cipher: 'AES-256-GCM',
    key_wrap: 'RSA-OAEP-SHA256',
    wrapped_key: publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      dataKey,
    ).toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    plaintext_sha256: createHash('sha256').update(plain).digest('hex'),
    plaintext_bytes: plain.length,
  }
  dataKey.fill(0)
  const stamp = header.created_at.replace(/[:.]/g, '-')
  const target = join(values.out, `kinetrail-${stamp}.kbak`)
  writeFileSync(target, Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), ciphertext]), {
    flag: 'wx',
  })
  console.log(`backup written: ${target} (${ciphertext.length} bytes encrypted)`)
} finally {
  try {
    // 尽力覆写明文后删除；SSD/快照不保证物理擦除，因此临时目录应位于加密卷。
    const size = statSync(plainPath).size
    const fd = openSync(plainPath, 'r+')
    writeSync(fd, Buffer.alloc(size))
    closeSync(fd)
  } catch {}
  rmSync(work, { recursive: true, force: true })
}

if (values.prune) {
  const files = readdirSync(values.out)
    .filter((f) => /^kinetrail-\d{4}-\d{2}-\d{2}T.*\.kbak$/.test(f))
    .sort()
    .reverse()
  const keep = new Set(files.slice(0, 30))
  const months = new Map()
  for (const f of files) {
    const month = f.slice('kinetrail-'.length, 'kinetrail-'.length + 7)
    if (!months.has(month)) months.set(month, f)
  }
  for (const f of [...months.values()].slice(0, 12)) keep.add(f)
  for (const f of files) {
    if (!keep.has(f)) {
      rmSync(join(values.out, f))
      console.log(`pruned: ${f}`)
    }
  }
}
