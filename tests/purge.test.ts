import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { handleCalendar } from '../src/calendar'
import { type IngestPayload, ingestHealthConnect } from '../src/ingest'
import { stageBatch } from '../src/measurements'
import { DELETE_PATH, deleteMeasurement, handleDelete, tombstoneHash } from '../src/purge'
import { ingestScale } from '../src/scale'
import { acquireLease } from '../src/sync'
import { clock, deps } from './fitdays-mock'
import gatewayItem from './fixtures/gateway-measurement.json'
import type { Loose } from './helpers'

const PROFILE = 'p_hc_test_owner'
const HC_CUTOVER = Date.parse('2026-06-01T00:00:00+08:00')
const SCALE_CUTOVER = Date.parse('2026-09-20T00:00:00+08:00')
const T_HC = Date.parse('2026-09-19T08:00:00+08:00')
// 与 ingest.test.ts 同一套合成值：测试环境的 HC_INGEST_TOKEN_SHA256 就是这个令牌的哈希。
const TOKEN = 'synthetic-ingest-token-value-0000000000' // SYNTHETIC-SECRET
const noFetch = async () => new Response(null, { status: 599 })
const c = clock(Date.parse('2026-09-22T12:00:00+08:00'))
const d = () => deps(noFetch, c.now)

const hcPayload = (time = T_HC, weight = 70.2): IngestPayload => ({
  schema_version: '1',
  groups: [
    {
      origin: 'cn.icomon.fitdayspro',
      time_ms: time,
      zone_offset_seconds: 28800,
      records: [
        {
          hc_id: '00000000-0000-4000-8000-000000000001',
          type: 'weight',
          value: weight,
          last_modified_ms: time,
        },
        {
          hc_id: '00000000-0000-4000-8000-000000000002',
          type: 'body_fat',
          value: 21,
          last_modified_ms: time,
        },
      ],
    },
  ],
  deleted_hc_ids: [],
})
const pushHc = (owner: string) => ingestHealthConnect(env, owner, PROFILE, HC_CUTOVER, hcPayload(), d())
const pushScale = (owner: string) =>
  ingestScale(
    env,
    owner,
    PROFILE,
    SCALE_CUTOVER,
    4,
    { schema_version: '1', measurements: [gatewayItem as Loose] },
    d(),
  )

const recordId = async (owner: string, prefix: string) =>
  (
    await env.DB.prepare('SELECT id FROM raw_records WHERE owner_id = ? AND source_record_id LIKE ?')
      .bind(owner, `${prefix}%`)
      .first<{ id: string }>()
  )?.id as string

/** 这个 owner 在各表里还剩多少行。 */
async function leftovers(owner: string) {
  const count = async (sql: string) => (await env.DB.prepare(sql).bind(owner).first<{ n: number }>())?.n
  return {
    records: await count('SELECT COUNT(*) AS n FROM raw_records WHERE owner_id = ?'),
    versions: await count('SELECT COUNT(*) AS n FROM raw_record_versions WHERE owner_id = ?'),
    chunks: await count(
      'SELECT COUNT(*) AS n FROM raw_chunks WHERE version_id IN (SELECT id FROM raw_record_versions WHERE owner_id = ?)',
    ),
    tombstones: await count('SELECT COUNT(*) AS n FROM deleted_measurements WHERE owner_id = ?'),
    authorizations: (
      await env.DB.prepare('SELECT COUNT(*) AS n FROM purge_authorizations').first<{ n: number }>()
    )?.n,
  }
}

describe('物理删除称重', () => {
  it('Health Connect 称重删除后一条不剩，墓碑不含读数；手机重推同一组被拒', async () => {
    const owner = crypto.randomUUID()
    expect(await pushHc(owner)).toMatchObject({ accepted: 1 })
    const id = await recordId(owner, 'hc:')
    expect(await deleteMeasurement(env.DB, owner, PROFILE, id, c.now())).toBe('deleted')
    expect(await leftovers(owner)).toEqual({
      records: 0,
      versions: 0,
      chunks: 0,
      tombstones: 1,
      authorizations: 0,
    })

    const tomb = await env.DB.prepare('SELECT * FROM deleted_measurements WHERE owner_id = ?')
      .bind(owner)
      .first<Loose>()
    expect(Object.keys(tomb).sort()).toEqual(['deleted_at', 'key_hash', 'owner_id'])
    expect(tomb.key_hash).toBe(await tombstoneHash('weight', PROFILE, `hc:cn.icomon.fitdayspro:${T_HC}`))

    // 基线过期后手机会重读 30 天，把 Health Connect 里还在的原记录推回来
    expect(await pushHc(owner)).toEqual({
      accepted: 0,
      unchanged: 0,
      rejected: [{ time_ms: T_HC, code: 'MEASUREMENT_DELETED' }],
      deletions_matched: 0,
      deletions_unmatched: 0,
    })
    expect((await leftovers(owner)).records).toBe(0)
    // 再删一次：已经没有了
    expect(await deleteMeasurement(env.DB, owner, PROFILE, id, c.now())).toBe('not_found')
  })

  it('网关称重删除后，秤重发同一帧被拒', async () => {
    const owner = crypto.randomUUID()
    await ingestHealthConnect(env, owner, PROFILE, HC_CUTOVER, hcPayload(T_HC, 70.1), d())
    expect(await pushScale(owner)).toMatchObject({ accepted: 1 })
    const id = await recordId(owner, 'ble:')
    expect(await deleteMeasurement(env.DB, owner, PROFILE, id, c.now())).toBe('deleted')
    expect(await pushScale(owner)).toEqual({
      accepted: 0,
      unchanged: 0,
      rejected: [{ time_ms: gatewayItem.time_ms, code: 'MEASUREMENT_DELETED' }],
    })
    // 同一 owner 的 HC 那次没被连带
    expect((await leftovers(owner)).records).toBe(1)
  })

  it('分块存储的大记录：已发布与未发布版本的分块一起删掉', async () => {
    const owner = crypto.randomUUID()
    const id = crypto.randomUUID()
    const versions = [crypto.randomUUID(), crypto.randomUUID()]
    const version = (vid: string, published: number, stage: number) =>
      env.DB.prepare(
        `INSERT INTO raw_record_versions (id, raw_record_id, owner_id, dataset, profile_ref, batch_id, generation,
           stage_index, published, raw_hash, byte_length, raw_format_version, sanitizer_version, raw_json, chunk_count,
           measured_at, is_deleted, formula_version, normalization_version, created_at)
         VALUES (?1, ?2, ?3, 'weight', ?4, 'b', 1, ?5, ?6, 'h', 4, 1, 1, NULL, 2, 1, 0, 'body_v1', '1', 0)`,
      ).bind(vid, id, owner, PROFILE, stage, published)
    const chunk = (vid: string, index: number) =>
      env.DB.prepare(
        'INSERT INTO raw_chunks (version_id, chunk_index, data, chunk_hash) VALUES (?, ?, ?, ?)',
      ).bind(vid, index, new Uint8Array([123, 125]), 'c')
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO raw_records (id, owner_id, dataset, profile_ref, source_record_id, identity_kind, first_seen_at, last_seen_at)
         VALUES (?, ?, 'weight', ?, 'ble:p3:0123456789abcdef0123456789abcdef', 'content_hash', 0, 0)`,
      ).bind(id, owner, PROFILE),
      version(versions[0] as string, 1, 0),
      version(versions[1] as string, 0, 1),
      chunk(versions[0] as string, 0),
      chunk(versions[0] as string, 1),
      chunk(versions[1] as string, 0),
      chunk(versions[1] as string, 1),
    ])
    expect(await deleteMeasurement(env.DB, owner, PROFILE, id, c.now())).toBe('deleted')
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM raw_chunks WHERE version_id IN (SELECT value FROM json_each(?))',
    )
      .bind(JSON.stringify(versions))
      .first<{ n: number }>()
    expect(left?.n).toBe(0)
    expect(await leftovers(owner)).toMatchObject({ records: 0, versions: 0, tombstones: 1 })
  })

  it('旧 FitDays 记录不开放删除；别的成员、不存在的 ID 当作找不到', async () => {
    const owner = crypto.randomUUID()
    const fitdays = crypto.randomUUID()
    const other = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO raw_records (id, owner_id, dataset, profile_ref, source_record_id, identity_kind, first_seen_at, last_seen_at)
         VALUES (?1, ?2, 'weight', ?3, 'fitdays-data-id', 'source_id', 0, 0),
                (?4, ?2, 'weight', 'p_someone_else', 'hc:cn.icomon.fitdayspro:1', 'source_id', 0, 0)`,
      ).bind(fitdays, owner, PROFILE, other),
    ])
    expect(await deleteMeasurement(env.DB, owner, PROFILE, fitdays, c.now())).toBe('not_deletable')
    expect(await deleteMeasurement(env.DB, owner, PROFILE, other, c.now())).toBe('not_found')
    expect(await deleteMeasurement(env.DB, owner, PROFILE, crypto.randomUUID(), c.now())).toBe('not_found')
    // 别的 owner 的记录也删不到
    expect(await deleteMeasurement(env.DB, crypto.randomUUID(), PROFILE, fitdays, c.now())).toBe('not_found')
    expect((await leftovers(owner)).records).toBe(2)
    // lease 已经放掉：下一次推送不会 busy
    expect(await pushHc(owner)).toMatchObject({ accepted: 1 })
  })

  it('没有授权行时，事实表照旧拒绝物理删除', async () => {
    const owner = crypto.randomUUID()
    await pushHc(owner)
    const id = await recordId(owner, 'hc:')
    await expect(env.DB.prepare('DELETE FROM raw_records WHERE id = ?').bind(id).run()).rejects.toThrow(
      /append-only/,
    )
    await expect(
      env.DB.prepare('DELETE FROM raw_record_versions WHERE raw_record_id = ?').bind(id).run(),
    ).rejects.toThrow(/immutable/)
    await expect(
      env.DB.prepare('UPDATE raw_record_versions SET metrics_json = ? WHERE raw_record_id = ?')
        .bind('{}', id)
        .run(),
    ).rejects.toThrow(/immutable/)
    expect((await leftovers(owner)).versions).toBe(1)
  })

  it('lease 被占用时 busy，不删', async () => {
    const owner = crypto.randomUUID()
    await pushHc(owner)
    const id = await recordId(owner, 'hc:')
    expect(await acquireLease(env.DB, owner, 'someone-else', c.now())).not.toBeNull()
    expect(await deleteMeasurement(env.DB, owner, PROFILE, id, c.now())).toBe('busy')
    expect((await leftovers(owner)).records).toBe(1)
  })

  it('lease 过期被接管后，旧推送的暂存一行也写不进去', async () => {
    const owner = crypto.randomUUID()
    const generation = (await acquireLease(env.DB, owner, 'old-batch', c.now())) as number
    // 删除（或别的推送）在 lease 过期后接管
    expect(await acquireLease(env.DB, owner, 'new-holder', c.now() + 3600_000)).not.toBeNull()
    const record = {
      dataset: 'weight' as const,
      profileRef: PROFILE,
      sourceRecordId: 'hc:cn.icomon.fitdayspro:1',
      identityKind: 'source_id' as const,
      rawText: '{}',
      rawHash: 'x',
      byteLength: 2,
      redactedPaths: [],
      sourceDataId: null,
      measuredTimeRaw: null,
      measuredAt: null,
      localDate: null,
      isDeleted: 0 as const,
      isDeletedRaw: null,
      deviceRef: null,
      impDataId: null,
      balanceDataId: null,
      gravityDataId: null,
      metrics: {},
      extParseStatus: 'missing',
      qualityFlags: [],
    }
    const prepared = {
      manifests: [],
      records: [record],
      blocked: [],
      profiles: [],
      devices: [],
      partial: false,
      excluded: 0,
    }
    await expect(stageBatch(env.DB, owner, 'old-batch', generation, prepared, c.now())).rejects.toThrow()
    expect(await leftovers(owner)).toMatchObject({ records: 0, versions: 0 })
  })
})

describe('物理删除称重：HTTP 与日历', () => {
  const post = (payload: unknown, token = TOKEN, ip = '192.0.2.20', e: Env = env) =>
    handleDelete(
      new Request(`https://kinetrail.test${DELETE_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify(payload),
      }),
      e,
      d(),
    )

  it('日历标出能删的记录；手机令牌删除后日历里没有了', async () => {
    const owner = crypto.randomUUID()
    const e = { ...env, OWNER_ID: owner }
    await pushHc(owner)
    const calendar = async () => {
      const response = await handleCalendar(
        new Request('https://kinetrail.test/app/calendar?from=2026-09-01&to=2026-09-30', {
          headers: { authorization: `Bearer ${TOKEN}`, 'cf-connecting-ip': '192.0.2.21' },
        }),
        e,
        d(),
      )
      return ((await response.json()) as Loose).days.flatMap((day: Loose) => day.measurements)
    }
    const [m] = await calendar()
    expect(m.deletable).toBe(true)

    expect((await post({ record_id: m.record_id }, 'wrong-token-value', '192.0.2.22', e)).status).toBe(401)
    expect((await post({ record_id: 'not-a-uuid' }, TOKEN, '192.0.2.23', e)).status).toBe(400)
    expect((await post({ record_id: m.record_id, extra: 1 }, TOKEN, '192.0.2.23', e)).status).toBe(400)
    expect((await post({ record_id: crypto.randomUUID() }, TOKEN, '192.0.2.23', e)).status).toBe(404)
    expect(
      (await post({ record_id: m.record_id }, TOKEN, '192.0.2.23', { ...e, HC_INGEST_TOKEN_SHA256: '' }))
        .status,
    ).toBe(404)

    const ok = await post({ record_id: m.record_id }, TOKEN, '192.0.2.24', e)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ deleted: true })
    expect(await calendar()).toEqual([])
  })

  it('全局每分钟最多删 10 次，换 IP 也一样', async () => {
    c.advance(3600_000) // 换一个限流窗口，不和上一条测试共用计数
    const e = { ...env, OWNER_ID: crypto.randomUUID() }
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      statuses.push((await post({ record_id: crypto.randomUUID() }, TOKEN, `198.51.100.${i}`, e)).status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})
