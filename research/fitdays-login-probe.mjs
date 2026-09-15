// FitDays 会话并发实验（2026-09-15）：新登录是否让同账号旧 token 失效，按 os_type 区分是否能并存。
// 只调用 login 与 syncFromServer（最近 1 天）；不打印 token、账号、测量数据，只打印返回码和提示语。
// 凭据从环境变量 FD_LOGIN / FD_PASSWORD 读取（由用户在自己的终端里输入），区域 FD_REGION 默认 cn。
import { APP_VER, buildSign, hashPassword, newClientId, newRequestId, USER_AGENT } from 'fitdays-api'

const HOSTS = { cn: 'https://online.fitdays.cn', eu: 'https://online-eu.fitdays.cn', us: 'https://online-us.fitdays.cn' }
const REGION = process.env.FD_REGION ?? 'cn'
const LOGIN = process.env.FD_LOGIN
const PASSWORD = process.env.FD_PASSWORD
if (!HOSTS[REGION] || !LOGIN || !PASSWORD) {
  console.error('需要 FD_LOGIN、FD_PASSWORD，FD_REGION 只能是 cn/eu/us')
  process.exit(2)
}
const [country, language] = REGION === 'cn' ? ['CN', 'zh'] : ['US', 'en']
const DEVICE = { 0: 'AndroidSDKbuiltforarm64-6.0', 1: 'iPhone14,5' }
const secrets = [LOGIN, PASSWORD, hashPassword(PASSWORD)]

const safeMsg = (msg) => {
  let text = String(msg ?? '').slice(0, 60)
  for (const s of secrets) if (s) text = text.replaceAll(s, '<redacted>')
  return text.replace(/[A-Za-z0-9._-]{20,}/g, '<redacted>')
}

function makeClient(label, osType) {
  const clientId = newClientId()
  let base = HOSTS[REGION]
  let session = null
  async function call(path, body) {
    const params = {
      app_ver: APP_VER,
      client_id: clientId,
      country,
      device_model: DEVICE[osType],
      language,
      os_type: osType,
      request_id: newRequestId(),
      source: '0',
      timestamp: String(Math.floor(Date.now() / 1000)),
      token: session?.token ?? '',
      uid: session ? String(session.uid) : '0',
    }
    const qs = new URLSearchParams(params)
    qs.append('sign', buildSign(params))
    qs.append('capp_ver', APP_VER)
    for (let hop = 0; hop < 2; hop++) {
      const res = await fetch(`${base}/${path}?${qs}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json;charset=UTF-8', 'user-agent': USER_AGENT },
        body: JSON.stringify(body),
      })
      let json
      try {
        json = JSON.parse(await res.text())
      } catch {
        return { code: `HTTP ${res.status} non-JSON`, msg: '' }
      }
      const domain = json?.data?.domain
      if (json?.code === 302 && typeof domain === 'string') {
        const url = new URL(domain)
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.fitdays.cn')) return { code: '302 to non-fitdays host', msg: '' }
        base = url.origin
        continue
      }
      return { code: json?.code, msg: json?.msg, data: json?.data }
    }
    return { code: 'too many 302', msg: '' }
  }
  return {
    label,
    async login() {
      const r = await call('api/users/login', { email: LOGIN, password: hashPassword(PASSWORD) })
      const token = r.data?.token ?? r.data?.account?.token
      const uid = r.data?.account?.uid ?? r.data?.uid
      if (token && uid !== undefined) session = { token, uid }
      return { code: r.code, msg: safeMsg(r.msg), gotToken: Boolean(token) }
    },
    async probe() {
      const now = Math.floor(Date.now() / 1000)
      const r = await call('api/sync/syncFromServer', { start_time: now, end_time: now - 86400 })
      return { code: r.code, msg: safeMsg(r.msg) }
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

const A = makeClient('A android', '0')
const B = makeClient('B android', '0')
const C = makeClient('C ios', '1')
const D = makeClient('D android', '0')

await step('1 登录 A(android)', () => A.login())
await step('1 A 读取', () => A.probe())
await step('2 登录 B(android, 新 client_id)', () => B.login())
await step('2 A 读取（B 登录后）', () => A.probe())
await step('2 B 读取', () => B.probe())
await step('3 登录 C(ios)', () => C.login())
await step('3 B 读取（C 登录后）', () => B.probe())
await step('3 C 读取', () => C.probe())
await step('4 登录 D(android)', () => D.login())
await step('4 C 读取（D 登录后）', () => C.probe())
await step('4 D 读取', () => D.probe())

console.log(`区域 ${REGION}，app_ver ${APP_VER}`)
console.table(rows)
