// 加密导出 D1：wrangler d1 export → AES-256-GCM 加密 → RSA-OAEP-SHA256 包裹数据密钥（只需加密公钥）
// → Ed25519 签名覆盖头部与密文（防止拿到公钥的人伪造备份）。
// 明文 SQL 只在临时目录停留，加密后覆写并删除；启动时先清扫上次中断留下的临时目录。
// 解密私钥不应放在运行本脚本或 Worker 的环境里；签名私钥只放在执行备份的机器上。
//
// node scripts/backup.mjs --public-key backup-public.pem --signing-key backup-signing.pem --out D:\kinetrail-backups
//   [--database kinetrail]
//   [--local]  从 wrangler dev 的本地库导出（恢复演练用）
//   [--prune]  按保留策略删除旧备份：最近 30 个日备份 + 每月最后一个（保留 12 个月）
import { execFileSync } from 'node:child_process'
import {
  constants,
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  sign,
} from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    'public-key': { type: 'string' },
    'signing-key': { type: 'string' },
    out: { type: 'string' },
    database: { type: 'string', default: 'kinetrail' },
    local: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
  },
})
if (!values['public-key'] || !values['signing-key'] || !values.out) {
  console.error(
    'usage: node scripts/backup.mjs --public-key <pem> --signing-key <ed25519 pem> --out <dir> [--database kinetrail] [--local] [--prune]',
  )
  process.exit(2)
}

const publicKey = createPublicKey(readFileSync(values['public-key']))
if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 3072) {
  console.error('public key must be RSA >= 3072 bits')
  process.exit(2)
}
const signingKey = createPrivateKey({
  key: readFileSync(values['signing-key']),
  passphrase: process.env.KINETRAIL_SIGNING_PASSPHRASE,
})
if (signingKey.asymmetricKeyType !== 'ed25519') {
  console.error('signing key must be Ed25519')
  process.exit(2)
}

function shred(dir) {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      try {
        // 只覆写普通文件；符号链接可能指向别人的文件，不跟随。
        const info = lstatSync(path)
        if (!info.isFile()) continue
        const fd = openSync(path, 'r+')
        writeSync(fd, Buffer.alloc(info.size))
        closeSync(fd)
      } catch {}
    }
  } catch {}
  rmSync(dir, { recursive: true, force: true })
}

// 上次被中断（Ctrl+C、崩溃）留下的明文导出：只清扫本用户、非符号链接、超过 6 小时的目录，
// 避免误伤共享 /tmp 里他人伪造的目录，也避免清掉另一个正在运行的备份。
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith('kinetrail-backup-')) continue
  const path = join(tmpdir(), name)
  try {
    const info = lstatSync(path)
    const ownedByMe = typeof process.getuid !== 'function' || info.uid === process.getuid()
    if (
      info.isDirectory() &&
      !info.isSymbolicLink() &&
      ownedByMe &&
      Date.now() - info.mtimeMs > 6 * 3600_000
    ) {
      shred(path)
    }
  } catch {}
}

const work = mkdtempSync(join(tmpdir(), 'kinetrail-backup-'))
const plainPath = join(work, 'export.sql')
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    shred(work)
    process.exit(130)
  })
}
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
    format: 'kinetrail-backup-v2',
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
  const headerText = JSON.stringify(header)
  const signature = sign(null, Buffer.concat([Buffer.from(`${headerText}\n`), ciphertext]), signingKey)
  const stamp = header.created_at.replace(/[:.]/g, '-')
  const target = join(values.out, `kinetrail-${stamp}.kbak`)
  const signed = JSON.stringify({ ...header, signature: signature.toString('base64') })
  writeFileSync(target, Buffer.concat([Buffer.from(`${signed}\n`), ciphertext]), { flag: 'wx' })
  console.log(`backup written: ${target} (${ciphertext.length} bytes encrypted, signed)`)
} finally {
  shred(work)
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
