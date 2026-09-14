import { describe, expect, it } from 'vitest'
import { findSecretPath, sanitizeRecord } from '../src/sanitize'
import { parseLossless } from '../src/util'
import { SYNTHETIC } from './fitdays-mock'

const secrets = new Set([SYNTHETIC.token, SYNTHETIC.email])
const clean = (text: string, dataset = 'weight') => sanitizeRecord(parseLossless(text), dataset, secrets)

describe('秘密边界', () => {
  it('未知数值/结构原样保留，ext_data 未改动时逐字节保留原串', () => {
    const ext = '{ "smi": 7.1, "futureMetric": {"v":12} }'
    const r = clean(
      JSON.stringify({ data_id: 'w', unknown: { a: [1, null, 3] }, ext_data: ext }).replace('"a"', '"a"'),
    )
    expect(r.blocked).toEqual([])
    expect(r.value.ext_data).toBe(ext)
    expect(r.extStatus).toBe('ok')
    expect(JSON.stringify(r.value.unknown)).toBe('{"a":[1,null,3]}')
  })

  it('null / 空串 / 缺失 / 无法解析的 ext_data 分别标记，无法解析时保留原串', () => {
    expect(clean('{"ext_data":null}').extStatus).toBe('null')
    expect(clean('{"ext_data":""}').extStatus).toBe('empty')
    expect(clean('{"data_id":"x"}').extStatus).toBe('missing')
    const invalid = clean('{"ext_data":"{invalid"}')
    expect(invalid.extStatus).toBe('invalid')
    expect(invalid.value.ext_data).toBe('{invalid')
  })

  it('嵌套秘密键、ext_data 内秘密键、已知秘密值被移除并记录路径', () => {
    const r = clean(
      JSON.stringify({
        data_id: 'w',
        extra: { refresh_token: 'x', ok: 1 },
        ext_data: JSON.stringify({ smi: 7, nested: { access_token: 'y' } }),
        weird_number_string: SYNTHETIC.token,
      }),
    )
    expect(r.blocked).toEqual([])
    expect(r.redactedPaths.sort()).toEqual([
      'ext_data.nested.access_token',
      'extra.refresh_token',
      'weird_number_string',
    ])
    expect(JSON.stringify(r.value)).not.toContain('refresh_token')
    expect(String(r.value.ext_data)).not.toContain('access_token')
    expect(JSON.stringify(r.value)).not.toContain(SYNTHETIC.token)
  })

  it('未知字段里的自由字符串 fail-closed：阻断整条记录，只记路径和类型', () => {
    const r = clean('{"data_id":"w","note":"今天状态不错"}')
    expect(r.blocked).toEqual([{ path: 'note', valueType: 'string', code: 'UNCLASSIFIED_STRING' }])
    const impedance = clean('{"data_id":"i","opaque":"QUJDREVGRw=="}', 'impedance')
    expect(impedance.blocked).toHaveLength(1)
    // 数值形态、逗号分隔数值、日期时间在未知字段中允许
    expect(
      clean('{"data_id":"i","imps":"500,501","t":"2026-09-14 10:00:00","n":"12.5"}', 'impedance').blocked,
    ).toEqual([])
  })

  it('邮箱、URL、JWT、MAC、手机号形态被移除；无法解析又含秘密的 ext_data 阻断', () => {
    const r = clean(
      JSON.stringify({
        data_id: 'w',
        a: 'someone@example.invalid',
        b: 'https://x.invalid/?sign=abc',
        c: 'AA:BB:CC:DD:EE:FF',
        d: '13912345678',
      }),
    )
    expect(r.redactedPaths.sort()).toEqual(['a', 'b', 'c', 'd'])
    const blocked = clean(JSON.stringify({ ext_data: `{broken ${SYNTHETIC.token}` }))
    expect(blocked.blocked[0]?.code).toBe('SECRET_IN_UNPARSEABLE_STRING')
  })

  it('审查回归：截断的 ext_data 里出现秘密键名时整条阻断，输出检查也能发现', () => {
    const truncated = '{"refresh_token":"rt-other-device-9f8e7d6c5b4a","bfr":20'
    const r = clean(JSON.stringify({ data_id: 'w', ext_data: truncated }))
    expect(r.blocked[0]?.code).toBe('SECRET_IN_UNPARSEABLE_STRING')
    expect(findSecretPath({ raw_json: JSON.stringify({ ext_data: truncated }) })).toBe('raw_json.ext_data')
    expect(findSecretPath({ note: '{"bfr":20' })).toBeNull()
  })

  it('审查回归：带空格/国际前缀的手机号、数字型手机号与已知秘密值被移除；已知数字字段不误伤', () => {
    const r = sanitizeRecord(
      parseLossless(
        JSON.stringify({
          data_id: 'w',
          a: '139 1234 5678',
          b: '008613912345678',
          c: 13812345678,
          suid: 13812345678,
          login_number: 18612345678,
        }),
      ),
      'weight',
      new Set(['18612345678']),
    )
    expect(r.redactedPaths.sort()).toEqual(['a', 'b', 'c', 'login_number'])
    expect(JSON.stringify(r.value)).toContain('"suid":13812345678')
  })

  it('审查回归：__proto__ / constructor 键作为普通数据保留，不触发原型访问', () => {
    const r = clean('{"data_id":"w","__proto__":{"x":1},"constructor":5,"ext_data":"{\\"__proto__\\":2}"}')
    expect(r.blocked).toEqual([])
    expect(JSON.stringify(r.value)).toBe(
      '{"data_id":"w","__proto__":{"x":1},"constructor":5,"ext_data":"{\\"__proto__\\":2}"}',
    )
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype)
  })

  it('输出二次检查能发现 raw_json 字符串内的秘密键', () => {
    expect(findSecretPath({ items: [{ raw_json: '{"x":{"token":"t"}}' }] })).toBe('items[0].raw_json.x.token')
    expect(
      findSecretPath({ items: [{ raw_json: '{"x":1}', session_id: 's', idempotency_key: 'k' }] }),
    ).toBeNull()
  })
})
