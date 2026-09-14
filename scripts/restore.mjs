// 先验证 Ed25519 签名，再解密备份为 SQL，供导入“隔离的”恢复数据库后校验。不会触碰线上数据库。
//
// node scripts/restore.mjs --backup kinetrail-....kbak --verify-key backup-signing-public.pem \
//   --private-key backup-private.pem --out restore.sql
// 解密私钥若有口令，通过环境变量 KINETRAIL_BACKUP_PASSPHRASE 提供（不要放在命令行参数里）。
import {
  constants,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  verify,
} from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    backup: { type: 'string' },
    'verify-key': { type: 'string' },
    'private-key': { type: 'string' },
    out: { type: 'string' },
  },
})
if (!values.backup || !values['verify-key'] || !values['private-key'] || !values.out) {
  console.error(
    'usage: node scripts/restore.mjs --backup <file.kbak> --verify-key <ed25519 public pem> --private-key <pem> --out <restore.sql>',
  )
  process.exit(2)
}

const raw = readFileSync(values.backup)
const newline = raw.indexOf(0x0a)
const signed = JSON.parse(raw.subarray(0, newline).toString('utf8'))
if (signed.format !== 'kinetrail-backup-v2') throw new Error('unsupported backup format')
const { signature, ...header } = signed
const ciphertext = raw.subarray(newline + 1)
const verifyKey = createPublicKey(readFileSync(values['verify-key']))
if (verifyKey.asymmetricKeyType !== 'ed25519') throw new Error('verify key must be Ed25519')
const signedBytes = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), ciphertext])
if (
  typeof signature !== 'string' ||
  !verify(null, signedBytes, verifyKey, Buffer.from(signature, 'base64'))
) {
  throw new Error('backup signature verification failed')
}

const privateKey = createPrivateKey({
  key: readFileSync(values['private-key']),
  passphrase: process.env.KINETRAIL_BACKUP_PASSPHRASE,
})
const dataKey = privateDecrypt(
  { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  Buffer.from(header.wrapped_key, 'base64'),
)
const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(header.iv, 'base64'))
decipher.setAuthTag(Buffer.from(header.tag, 'base64'))
const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
dataKey.fill(0)
const digest = createHash('sha256').update(plain).digest('hex')
if (digest !== header.plaintext_sha256 || plain.length !== header.plaintext_bytes) {
  throw new Error('backup integrity check failed')
}
writeFileSync(values.out, plain, { flag: 'wx' })
console.log(`verified signature and decrypted ${header.created_at} (${header.source}) -> ${values.out}`)
