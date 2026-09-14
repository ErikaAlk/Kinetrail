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
/** 去掉空格、括号、连字符并把 00 国际前缀当作 +，再判断是否像中国大陆手机号。 */
const phoneLike = (text: string) => CN_PHONE.test(text.replace(/[\s()-]/g, '').replace(/^00/, '+'))

const QUOTED_KEY = /["']([^"']{1,64})["']\s*:/g
/** 文本里是否出现带引号的秘密键名（如截断的 `{"refresh_token":"..."`）。用于写入输入与输出检查。 */
export function secretKeyInText(text: string): boolean {
  for (const match of text.matchAll(QUOTED_KEY)) if (isSecretKey(match[1] as string)) return true
  return false
}

type Token =
  | { kind: 'punct'; text: string }
  | { kind: 'string'; text: string; closed: boolean }
  | { kind: 'word'; text: string }

/** 线性词法分析，容忍末尾截断（未闭合的字符串）。不做回溯，输入长度与耗时成正比。 */
function lex(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i] as string
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      i++
    } else if ('{}[],:'.includes(c)) {
      tokens.push({ kind: 'punct', text: c })
      i++
    } else if (c === '"' || c === "'") {
      let j = i + 1
      let buf = ''
      let closed = false
      while (j < text.length) {
        const d = text[j] as string
        if (d === '\\') {
          // 解码转义（含 Unicode 转义），避免用转义写法把秘密键名藏过去。
          const escaped = text[j + 1] ?? ''
          const hex = text.slice(j + 2, j + 6)
          if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) {
            buf += String.fromCharCode(Number.parseInt(hex, 16))
            j += 6
          } else {
            buf +=
              ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[escaped] ?? escaped
            j += 2
          }
        } else if (d === c) {
          closed = true
          j++
          break
        } else {
          buf += d
          j++
        }
      }
      tokens.push({ kind: 'string', text: buf, closed })
      i = j
    } else {
      let j = i
      while (j < text.length && !' \n\r\t{}[],:"\''.includes(text[j] as string)) j++
      tokens.push({ kind: 'word', text: text.slice(i, j) })
      i = j
    }
  }
  return tokens
}

const safeShape = (text: string) => SAFE_SHAPES.some((re) => re.test(text.trim()))
/** 截断的数字/日期前缀，如 `2026-09-1`、`12.`、`1e`。 */
const safePrefix = (text: string) => /^[\d\s.,;|:+\-TZeE]*$/.test(text)

/**
 * 采集时对“JSON 样但无法解析”的字符串做 fail-closed 判断，与能解析时的规则一致，并容忍末尾截断：
 * - 键（带不带引号都算，后面跟冒号）不能是秘密键；末尾没有冒号的键片段只查是否秘密键；
 * - 值位置的字符串必须是安全形态，已知字符串键（如 deviceModelExt）除外；末尾被截断的值允许数字/日期前缀；
 * - 值位置的裸词只允许数字、true/false/null（末尾允许它们的前缀）；键位置的裸词只允许 12 个字母以内（如 `{invalid`）。
 */
export function unparseableSafe(text: string, knownStringKeys: ReadonlySet<string>): boolean {
  const tokens = lex(text)
  const containers: string[] = []
  let lastKey: string | null = null
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k] as Token
    if (token.kind === 'punct') {
      if (token.text === '{' || token.text === '[') containers.push(token.text)
      else if (token.text === '}' || token.text === ']') containers.pop()
      continue
    }
    const prev = tokens[k - 1]
    const next = tokens[k + 1]
    const atEnd = k === tokens.length - 1
    if (next?.kind === 'punct' && next.text === ':') {
      if (isSecretKey(token.text) || isSuspiciousValue(token.text)) return false
      lastKey = token.text
      continue
    }
    const valuePosition = prev?.kind === 'punct' && prev.text === ':'
    // 只有对象里 `{` 或 `,` 之后才是键位置；数组元素永远是值。
    const inObject = containers.at(-1) === '{' || containers.length === 0
    const keyPosition =
      inObject && (!prev || (prev.kind === 'punct' && (prev.text === '{' || prev.text === ',')))
    const known = valuePosition && lastKey !== null && knownStringKeys.has(lastKey)
    // 与能解析时一致：已知字符串键下不做手机号形态判断，其他位置都查。
    if (isSuspiciousValue(token.text, undefined, !known)) return false
    if (token.kind === 'string') {
      if (atEnd && keyPosition) {
        if (isSecretKey(token.text)) return false
        continue
      }
      if (known) continue
      if (safeShape(token.text) || (atEnd && !token.closed && safePrefix(token.text))) continue
      return false
    }
    if (/^(true|false|null)$/.test(token.text) || safeShape(token.text)) continue
    if (atEnd && (safePrefix(token.text) || ['true', 'false', 'null'].some((l) => l.startsWith(token.text))))
      continue
    if (keyPosition && /^[A-Za-z]{1,12}$/.test(token.text)) continue
    return false
  }
  return true
}

/** 以自有属性写入，避免 `__proto__` 等键被当成原型访问器（数据丢失或原型污染）。 */
const setOwn = (target: Record<string, unknown>, key: string, value: unknown) =>
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })

export function isSuspiciousValue(
  value: string,
  knownSecrets: ReadonlySet<string> = new Set(),
  checkPhone = true,
): boolean {
  if (SUSPICIOUS_VALUE.some((re) => re.test(value))) return true
  if (checkPhone && phoneLike(value.trim())) return true
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
  if (value === null || typeof value === 'boolean') return value
  if (isRawNumber(value) || typeof value === 'number') {
    // 数字形式的秘密（登录手机号、数字 openid）同样拦截；已知数字字段不做手机号形态判断。
    const lexeme = isRawNumber(value) ? value.rawJSON : String(value)
    return ctx.secrets.has(lexeme) || (!allowed && phoneLike(lexeme)) ? REMOVE : value
  }
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
      else setOwn(out, key, next)
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
    if (!unparseableSafe(value, new Set())) {
      ctx.blocked.push({ path, valueType: 'string', code: 'SECRET_IN_UNPARSEABLE_STRING' })
      return value
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
      if (ext.value !== REMOVE) setOwn(out, key, ext.value)
      continue
    }
    const allowed = allowedKeys.has(key)
    const scalar = item === null || typeof item !== 'object' || isRawNumber(item)
    const next = walk(item, key, allowed && scalar, ctx)
    if (next === REMOVE) ctx.redacted.push(key)
    else setOwn(out, key, next)
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
    // 无法解析：能确认内容安全时原串保留（解析失败不丢 raw）；含秘密或无法分类的内容时无法重建，只能整条阻断。
    if (isSuspiciousValue(item, ctx.secrets) || !unparseableSafe(item, EXT_STRING_KEYS)) {
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
    const next = walk(item, childPath, allowed, ctx)
    if (next === REMOVE) ctx.redacted.push(childPath)
    else setOwn(out, key, next)
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
        return secretKeyInText(value) ? path || '$' : null
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
