// FitDays+（cn.icomon.fitdayspro 1.14.1）登录与会话并发实验（2026-09-15）。
// 请求构造来自对本人设备上已安装 App 的静态分析：
//   头部 user-agent/request-id/client-id/account-id/app-ver/device-model/package-name/timestamp/token，
//   sign = md5(javaUrlEncode(按键排序的 "k=v&..."（上述头部 + country）+ "fitdayspro"))，timezone 与 type 头不参与签名；
//   查询参数 os_type=2&bapp_ver=1.0.0&country&language&source=0；请求体 JSON。
//   登录体 {account, type:1, vcode:"", access_code: md5(md5(pw+"fitdayspro")), access_sign: md5(md5(urlencode(pw+"fitdayspro")))}。
// 只调用 /api/account/login 与 /api/sync/sync_from_server（最近 1 天）；不打印 token、账号或任何记录值，
// 同步结果只打印顶层字段名与列表条数。凭据从 FD_LOGIN / FD_PASSWORD 读取，FD_COUNTRY 默认 CN。
import { randomUUID } from 'node:crypto'
import { javaUrlEncode, md5Hex } from 'fitdays-api'

const LOGIN = process.env.FD_LOGIN
const PASSWORD = process.env.FD_PASSWORD
const COUNTRY = process.env.FD_COUNTRY ?? 'CN'
if (!LOGIN || !PASSWORD) {
  console.error('需要 FD_LOGIN、FD_PASSWORD')
  process.exit(2)
}
const LANGUAGE = COUNTRY === 'CN' ? 'zh' : 'en'
const APP_VER = '1.14.1'
const secrets = [LOGIN, PASSWORD]

const safeMsg = (msg) => {
  let text = String(msg ?? '').slice(0, 60)
  for (const s of secrets) if (s) text = text.replaceAll(s, '<redacted>')
  return text.replace(/[A-Za-z0-9._-]{20,}/g, '<redacted>')
}
const shape = (data) => {
  if (!data || typeof data !== 'object') return String(typeof data)
  return Object.entries(data)
    .map(([k, v]) => (Array.isArray(v) ? `${k}[${v.length}]` : k))
    .join(',')
    .slice(0, 300)
}

function makeClient(label, osType = '2') {
  const clientId = md5Hex(randomUUID())
  let base = COUNTRY === 'CN' ? 'https://plus-cn.fitdays.cn' : 'https://plus-us.fitdays.cn'
  let session = { token: '', accountId: '0' }

  async function call(path, body) {
    for (let hop = 0; hop < 3; hop++) {
      const headers = {
        'user-agent': `FitdaysPlus-${APP_VER}`,
        'request-id': md5Hex(randomUUID()),
        'client-id': clientId,
        'account-id': session.accountId,
        'app-ver': APP_VER,
        'device-model': 'OnePlus-OPD2413-16',
        'package-name': 'cn.icomon.fitdayspro',
        timestamp: String(Math.floor(Date.now() / 1000)),
        token: session.token,
      }
      const signed = { ...headers, country: COUNTRY }
      const joined = Object.keys(signed)
        .sort()
        .map((k) => `${k}=${signed[k]}`)
        .join('&')
      headers.timezone = String(8 * 3600 * 1000)
      headers.sign = md5Hex(javaUrlEncode(`${joined}fitdayspro`)).toLowerCase()
      headers.type = '1'
      const qs = new URLSearchParams({ os_type: osType, bapp_ver: '1.0.0', country: COUNTRY, language: LANGUAGE, source: '0' })
      const res = await fetch(`${base}${path}?${qs}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...headers, 'content-type': 'application/json;charset=utf-8' },
        body: JSON.stringify(body),
      })
      let json
      try {
        json = JSON.parse(await res.text())
      } catch {
        return { code: `HTTP ${res.status} non-JSON`, msg: '' }
      }
      const domain = json?.data?.domain
      if (String(json?.code) === '302' && typeof domain === 'string') {
        const url = new URL(domain)
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.fitdays.cn')) return { code: '302 to non-fitdays host', msg: '' }
        base = url.origin
        continue
      }
      return { code: json?.code, msg: json?.msg, data: json?.data, host: new URL(base).hostname }
    }
    return { code: 'too many 302', msg: '' }
  }

  return {
    label,
    async login() {
      const salted = `${PASSWORD}fitdayspro`
      const r = await call('/api/account/login', {
        access_code: md5Hex(md5Hex(salted)),
        access_sign: md5Hex(md5Hex(javaUrlEncode(salted))),
        account: LOGIN,
        type: 1,
        vcode: '',
      })
      const token = r.data?.account?.token
      const accountId = r.data?.account?.account_id
      if (token && accountId !== undefined) session = { token, accountId: String(accountId) }
      return { code: r.code, msg: safeMsg(r.msg), gotToken: Boolean(token), host: r.host, shape: shape(r.data) }
    },
    async probe() {
      const now = Math.floor(Date.now() / 1000)
      const r = await call('/api/sync/sync_from_server', { count: 0, start_time: now - 86400, end_time: now })
      return { code: r.code, msg: safeMsg(r.msg), shape: shape(r.data) }
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const step = async (what, fn) => {
  const out = await fn()
  rows.push({ 步骤: what, ...out })
  await sleep(2000)
}

const A = makeClient('A')
const B = makeClient('B')
const C = makeClient('C os_type=1', '1')

await step('1 登录 A', () => A.login())
await step('1 A 读取', () => A.probe())
await step('2 登录 B（新 client-id）', () => B.login())
await step('2 A 读取（B 登录后）', () => A.probe())
await step('2 B 读取', () => B.probe())
await step('3 登录 C（os_type=1）', () => C.login())
await step('3 B 读取（C 登录后）', () => B.probe())
await step('3 C 读取', () => C.probe())

console.log(`FitDays+ ${APP_VER}，country ${COUNTRY}`)
console.table(rows)
