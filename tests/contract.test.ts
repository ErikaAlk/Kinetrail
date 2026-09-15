import { describe, expect, it } from 'vitest'
import contract from '../research/mcp-schemas.json'
import { createWorker } from '../src/index'
import { contractTools, defs } from '../src/schemas'
import { TOOLS } from '../src/tools'
import { issueToken, rpc, testDeps } from './helpers'

describe('契约闭合', () => {
  it('TS schema 与 research/mcp-schemas.json 完全一致', () => {
    expect(defs).toEqual(contract.$defs)
    expect(contractTools).toEqual(contract.tools)
  })

  it('tools/list 实际输出 19 个工具，annotations/securitySchemes 与契约一致且无 $ref', async () => {
    const worker = createWorker(testDeps())
    const { access_token } = await issueToken(worker, ['body:read'])
    const res = await rpc(worker, access_token, 'tools/list')
    expect(res.status).toBe(200)
    const tools = res.body.result.tools as Record<string, unknown>[]
    expect(tools).toHaveLength(19)
    for (const expected of contract.tools) {
      const actual = tools.find((t) => t.name === expected.name)
      expect(actual, expected.name).toBeDefined()
      expect(actual?.securitySchemes).toEqual(expected.securitySchemes)
      expect(actual?._meta).toEqual(expected._meta)
      expect(actual?.annotations).toMatchObject(expected.annotations)
      expect(typeof actual?.title).toBe('string')
      expect(String(actual?.description)).toMatch(/[一-鿿]/)
      expect(JSON.stringify(actual)).not.toContain('$ref')
    }
  })

  it('刷新与训练写工具不是只读；查询工具是只读', () => {
    const writes = [
      'refresh_data',
      'start_workout_session',
      'record_workout_event',
      'finalize_workout_session',
      'reopen_workout_session',
      'amend_workout_entry',
    ]
    for (const tool of contractTools) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(!writes.includes(tool.name))
      expect(tool.annotations.openWorldHint).toBe(false)
    }
    const scope = (name: string) => contractTools.find((t) => t.name === name)?.securitySchemes[0]?.scopes
    expect(scope('refresh_data')).toEqual(['body:sync'])
    for (const name of writes.slice(1)) expect(scope(name)).toEqual(['workout:write'])
  })

  it('比 schema 更严的 limit 上限写在工具描述里（模型只看得到 schema 与描述）', () => {
    const description = (name: string) => TOOLS.find((t) => t.name === name)?.description ?? ''
    // 2026-09-15 真实聊天中模型对 get_workout_history 连续传了 3 次超限 limit，才猜到上限。
    expect(description('get_workout_history')).toMatch(/最多都是 20/)
    expect(description('get_raw_dataset')).toMatch(/最多 100/)
    expect(description('get_measurements')).toMatch(/最多 25/)
  })

  it('读工具不接受隐式刷新参数', () => {
    const latest = contractTools.find((t) => t.name === 'get_latest_measurement_full')
    expect(Object.keys((latest?.inputSchema.properties as object) ?? {})).not.toContain('refresh_if_stale')
  })
})
