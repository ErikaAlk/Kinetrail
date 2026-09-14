// 秘密边界：采集时阻断/脱敏，输出前二次检查。
// 这不是能识别任意未来秘密的通用算法：已知秘密值精确匹配是可靠部分；键名与值形态规则是兜底；
// 未知字段里的自由字符串一律 fail-closed（整条记录不发布，只记路径/类型/错误码）。

import { isRawNumber, parseLossless } from './util'

export const SANITIZER_VERSION = 1

const SECRET_KEYS = new Set([
  'account',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'password',
  'passwd',
  'pwd',
  'email',
  'mail',
  'phone',
  'mobile',
  'tel',
  'telephone',
  'openid',
  'unionid',
  'authorization',
  'auth',
  'cookie',
  'setcookie',
  'sid',
  'secret',
  'clientsecret',
  'apikey',
  'sign',
  'signature',
  'mac',
  'macaddress',
  'sn',
  'serial',
  'serialnumber',
  'wifiextdata',
  'ssid',
  'bssid',
  'ip',
  'ipaddress',
  'birthday',
  'photo',
  'avatar',
  'remarkname',
  'idcard',
  'realname',
])
const SECRET_KEY_PARTS = [
  'token',
  'password',
  'passwd',
  'secret',
  'cookie',
  'authorization',
  'openid',
  'unionid',
  'email',
  'phone',
  'mobile',
  'apikey',
  'signature',
  'credential',
]

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '')

export function isSecretKey(key: string): boolean {
  const k = normalizeKey(key)
  return SECRET_KEYS.has(k) || SECRET_KEY_PARTS.some((part) => k.includes(part))
}

/** 认证/联系方式类键（不含 account 容器、日期等身份上下文），其值可作为精确匹配的已知秘密。 */
export const isCredentialKey = (key: string): boolean => {
  const k = normalizeKey(key)
  return SECRET_KEY_PARTS.some((part) => k.includes(part))
}

const SUSPICIOUS_VALUE = [
  /^\s*bearer\s/i,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/, // JWT
  /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i, // email
  /https?:\/\//i, // 任何 URL：测量值不应含 URL，签名 URL 更不能进库
  /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i, // MAC
]
const CN_PHONE = /^(\+?86)?1[3-9]\d{9}$/

export function isSuspiciousValue(
  value: string,
  knownSecrets: ReadonlySet<string> = new Set(),
  checkPhone = true,
): boolean {
  if (SUSPICIOUS_VALUE.some((re) => re.test(value))) return true
  if (checkPhone && CN_PHONE.test(value.trim())) return true
  for (const secret of knownSecrets) {
    if (secret.length >= 6 && value.includes(secret)) return true
    if (value === secret) return true
  }
  return false
}

// 上游类型中明确为 string 的测量字段；这些字段仍做秘密检查，但不做形态阻断。
const COMMON_STRING_KEYS = [
  'data_id',
  'id',
  'uid',
  'suid',
  'device_id',
  'created_at',
  'updated_at',
  'measured_time',
  'source',
  'app_ver',
  'is_deleted',
]
const DATASET_STRING_KEYS: Record<string, Set<string>> = {
  weight: new Set([
    ...COMMON_STRING_KEYS,
    'adc_list',
    'balance_data_id',
    'gravity_data_id',
    'imp_data_id',
    'ext_data',
  ]),
  height: new Set(COMMON_STRING_KEYS),
}
const EXT_STRING_KEYS = new Set([
  'deviceModelExt',
  'deviceNameExt',
  'deviceSoftwareVer',
  'onlyMeasureWeight',
  'originalImps',
])

const SAFE_SHAPES = [
  /^$/,
  /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/,
  /^[-+]?\d+(\.\d+)?([,;| ]+[-+]?\d+(\.\d+)?)*$/,
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
]

export interface BlockedItem {
  path: string
  valueType: string
  code: 'UNCLASSIFIED_STRING' | 'SECRET_IN_UNPARSEABLE_STRING' | 'NOT_AN_OBJECT'
}

export type ExtParseStatus = 'missing' | 'null' | 'empty' | 'ok' | 'invalid' | 'blocked'

export interface SanitizedRecord {
  value: Record<string, unknown>
  redactedPaths: string[]
  blocked: BlockedItem[]
  extStatus: ExtParseStatus
  extParsed: unknown
}

const REMOVE = Symbol('remove')

interface Walk {
  secrets: ReadonlySet<string>
  redacted: string[]
  blocked: BlockedItem[]
}

const joinPath = (base: string, key: string | number) =>
  typeof key === 'number' ? `${base}[${key}]` : base ? `${base}.${key}` : key

/** 键名本身像秘密（如邮箱作键）时，路径里也不能出现原键名。 */
export const redactedPath = (base: string, key: string, secrets: ReadonlySet<string>) =>
  joinPath(base, isSuspiciousValue(key, secrets) ? '<redacted-key>' : key)

function walk(value: unknown, path: string, allowed: boolean, ctx: Walk): unknown {
  if (value === null || typeof value === 'boolean' || isRawNumber(value) || typeof value === 'number')
    return value
  if (typeof value === 'string') return walkString(value, path, allowed, ctx)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    value.forEach((item, i) => {
      const next = walk(item, joinPath(path, i), false, ctx)
      if (next === REMOVE) ctx.redacted.push(joinPath(path, i))
      else out.push(next)
    })
    return out
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const childPath = joinPath(path, key)
      if (isSecretKey(key) || isSuspiciousValue(key, ctx.secrets)) {
        ctx.redacted.push(redactedPath(path, key, ctx.secrets))
        continue
      }
      const next = walk(item, childPath, false, ctx)
      if (next === REMOVE) ctx.redacted.push(childPath)
      else out[key] = next
    }
    return out
  }
  ctx.blocked.push({ path, valueType: typeof value, code: 'UNCLASSIFIED_STRING' })
  return REMOVE
}

function walkString(value: string, path: string, allowed: boolean, ctx: Walk): unknown {
  const trimmed = value.trim()
  if (/^[[{]/.test(trimmed)) {
    let parsed: unknown
    try {
      parsed = parseLossless(value)
    } catch {
      parsed = REMOVE
    }
    if (parsed !== REMOVE) {
      const before = ctx.redacted.length
      const inner = walk(parsed, path, false, ctx)
      return ctx.redacted.length === before ? value : JSON.stringify(inner)
    }
  }
  // 已知字符串字段不做手机号形态判断，避免把 ID 误删；精确秘密值与 URL/邮箱等仍然拦截。
  if (isSuspiciousValue(value, ctx.secrets, !allowed)) return REMOVE
  if (allowed || SAFE_SHAPES.some((re) => re.test(trimmed))) return value
  ctx.blocked.push({ path, valueType: 'string', code: 'UNCLASSIFIED_STRING' })
  return value
}

/** 对单条测量记录做秘密阻断。blocked 非空时该记录不得发布。 */
export function sanitizeRecord(
  record: unknown,
  dataset: string,
  secrets: ReadonlySet<string>,
): SanitizedRecord {
  const ctx: Walk = { secrets, redacted: [], blocked: [] }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return {
      value: {},
      redactedPaths: [],
      blocked: [
        { path: '', valueType: Array.isArray(record) ? 'array' : typeof record, code: 'NOT_AN_OBJECT' },
      ],
      extStatus: 'missing',
      extParsed: null,
    }
  }
  const allowedKeys = DATASET_STRING_KEYS[dataset] ?? new Set(COMMON_STRING_KEYS)
  const out: Record<string, unknown> = {}
  let extStatus: ExtParseStatus = 'missing'
  let extParsed: unknown = null

  for (const [key, item] of Object.entries(record as Record<string, unknown>)) {
    if (isSecretKey(key) || isSuspiciousValue(key, secrets)) {
      ctx.redacted.push(redactedPath('', key, secrets))
      continue
    }
    if (key === 'ext_data') {
      const ext = sanitizeExt(item, ctx)
      extStatus = ext.status
      extParsed = ext.parsed
      if (ext.value !== REMOVE) out[key] = ext.value
      continue
    }
    const allowed = allowedKeys.has(key) && typeof item === 'string'
    const next = typeof item === 'string' ? walkString(item, key, allowed, ctx) : walk(item, key, false, ctx)
    if (next === REMOVE) ctx.redacted.push(key)
    else out[key] = next
  }
  return { value: out, redactedPaths: ctx.redacted, blocked: ctx.blocked, extStatus, extParsed }
}

function sanitizeExt(item: unknown, ctx: Walk): { value: unknown; status: ExtParseStatus; parsed: unknown } {
  if (item === null) return { value: null, status: 'null', parsed: null }
  if (typeof item !== 'string') {
    // 非字符串 ext_data 不是上游已知形态，按未知结构处理。
    return { value: walk(item, 'ext_data', false, ctx), status: 'invalid', parsed: null }
  }
  if (item === '') return { value: '', status: 'empty', parsed: null }
  let parsed: unknown
  try {
    parsed = parseLossless(item)
  } catch {
    // 无法解析：原串保留（解析失败不丢 raw），但含秘密时无法重建，只能整条阻断。
    if (isSuspiciousValue(item, ctx.secrets)) {
      ctx.blocked.push({ path: 'ext_data', valueType: 'string', code: 'SECRET_IN_UNPARSEABLE_STRING' })
      return { value: REMOVE, status: 'blocked', parsed: null }
    }
    return { value: item, status: 'invalid', parsed: null }
  }
  const before = ctx.redacted.length
  const blockedBefore = ctx.blocked.length
  const clean = walkExt(parsed, 'ext_data', ctx)
  const status: ExtParseStatus = ctx.blocked.length > blockedBefore ? 'blocked' : 'ok'
  const value = ctx.redacted.length === before ? item : JSON.stringify(clean)
  return { value, status, parsed: clean }
}

function walkExt(parsed: unknown, path: string, ctx: Walk): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return walk(parsed, path, false, ctx)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
    const childPath = joinPath(path, key)
    if (isSecretKey(key) || isSuspiciousValue(key, ctx.secrets)) {
      ctx.redacted.push(redactedPath(path, key, ctx.secrets))
      continue
    }
    const allowed = EXT_STRING_KEYS.has(key) && typeof item === 'string'
    const next =
      typeof item === 'string' ? walkString(item, childPath, allowed, ctx) : walk(item, childPath, false, ctx)
    if (next === REMOVE) ctx.redacted.push(childPath)
    else out[key] = next
  }
  return out
}

/** 输出前二次检查：返回第一个疑似秘密的路径，没有则 null。JSON 字符串会被展开检查。 */
export function findSecretPath(value: unknown, path = ''): string | null {
  if (typeof value === 'string') {
    if (isSuspiciousValue(value, undefined, false)) return path || '$'
    if (/^\s*[[{]/.test(value)) {
      try {
        return findSecretPath(JSON.parse(value), path)
      } catch {
        return null
      }
    }
    return null
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecretPath(value[i], joinPath(path, i))
      if (hit) return hit
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const childPath = joinPath(path, key)
      if (isSecretKey(key)) return childPath
      const hit = findSecretPath(item, childPath)
      if (hit) return hit
    }
  }
  return null
}
