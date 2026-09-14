import { env } from 'cloudflare:workers'
import { hashPassword } from 'fitdays-api'
import { describe, expect, it } from 'vitest'
import {
  getLatestMeasurementFull,
  getMeasurements,
  getRawDataset,
  getRawRecordChunk,
  getSyncStatus,
  listDevices,
  listProfiles,
} from '../src/queries'
import { type RunOptions, requestRefresh, runSyncJob, scheduledSync } from '../src/sync'
import { KtError, sha256Hex } from '../src/util'
import {
  baseData,
  clock,
  deps,
  SYNTHETIC,
  syncBody,
  syntheticSecrets,
  toolContext,
  upstream,
  weight,
} from './fitdays-mock'
import type { Loose } from './helpers'

const RANGE = { start: '2026-09-01T00:00:00+08:00', end: '2026-10-01T00:00:00+08:00' }
const DAY = 86_400_000

async function sync(
  ownerId: string,
  data: Record<string, unknown>,
  c: ReturnType<typeof clock>,
  options: RunOptions = {},
  mode: 'full' | 'incremental' = 'full',
) {
  const up = upstream(() => syncBody(data))
  const job = await requestRefresh(env.DB, ownerId, mode, c.now())
  await runSyncJob(env, job.job_id, deps(up.fetch, c.now), { secrets: syntheticSecrets(), ...options })
  return job.job_id
}

const owner = () => `owner-${crypto.randomUUID()}`
const ctxFor = (ownerId: string, c: ReturnType<typeof clock>) =>
  toolContext(ownerId, deps(upstream(() => '').fetch, c.now))
const data = <T = Loose>(outcome: { data: unknown }) => outcome.data as T

async function rejects(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof KtError) return error.code
    throw error
  }
  throw new Error('expected rejection')
}

describe('测量链：保真与 null 语义', () => {
  it('未知字段、数字原文、ext_data 原串、无效 ext_data、tombstone 与 manifest presence', async () => {
    const id = owner()
    const c = clock()
    const jobId = await sync(id, baseData(), c)
    const ctx = ctxFor(id, c)

    const raw = data<Loose[]>(
      await getRawDataset({ dataset: 'weight', ...RANGE, include_deleted: true }, ctx),
    )
    expect(raw).toHaveLength(4)
    const byId = (dataId: string) => raw.find((r) => JSON.parse(r.raw_json).data_id === dataId)
    const w1 = byId('w1')
    expect(w1.raw_json).toContain('"unknown_measurement":{"sample":[1,null,3]}')
    expect(JSON.parse(w1.raw_json).ext_data).toBe(weight().ext_data)
    expect(byId('w4').raw_json).toContain('"big":9007199254740993')
    expect(byId('w2').is_deleted).toBe(true)
    expect(JSON.stringify(raw)).not.toContain('"account"')

    const summaries = data<Loose[]>(await getMeasurements(RANGE, ctx))
    expect(summaries.map((s) => s.metrics.weight_kg).sort()).toEqual([70, 72, 74])
    const withDeleted = data<Loose[]>(await getMeasurements({ ...RANGE, include_deleted: true }, ctx))
    expect(withDeleted.find((s) => s.metrics.weight_kg === 71).quality_flags).toContain('tombstone')
    const w1Summary = summaries.find((s) => s.metrics.weight_kg === 70)
    expect(w1Summary.metrics.fat_mass_kg).toBe(14)
    expect(w1Summary.metrics.fat_free_mass_kg).toBe(56)
    expect(w1Summary.metrics.smi).toBe(7.1)
    expect(w1Summary.measured_at).toMatch(/\+08:00$/)

    const full = data<Loose[]>(await getMeasurements({ ...RANGE, detail: 'full' }, ctx))
    const w3 = full.find((m) => JSON.parse(m.weight.raw_json).data_id === 'w3')
    expect(w3.ext_parse_status).toBe('invalid')
    expect(w3.ext_data_raw).toBe('{invalid')
    expect(w3.ext_data_parsed).toBeNull()

    const batch = await env.DB.prepare('SELECT manifest_json, state FROM sync_batches WHERE id = ?')
      .bind(jobId)
      .first<Loose>()
    expect(batch.state).toBe('published')
    const manifest = JSON.parse(batch.manifest_json)[0].datasets
    expect(manifest.hr).toEqual({ presence: 'null', count: 0, keys: {} })
    expect(manifest.height.presence).toBe('missing')
    expect(manifest.rulers).toEqual({ presence: 'array', count: 0, keys: {} })
    expect(manifest.weight.keys.unknown_measurement).toEqual(['object'])
  })

  it('超出安全整数的已知指标：索引为 null 并标记，raw 保留原词法', async () => {
    const id = owner()
    const c = clock()
    await sync(id, { weight_list: [weight({ weight_kg: '__BIG__' })] }, c)
    const ctx = ctxFor(id, c)
    const [summary] = data<Loose[]>(await getMeasurements(RANGE, ctx))
    expect(summary.metrics.weight_kg).toBeNull()
    expect(summary.quality_flags).toContain('numeric_precision_unverified')
    const [raw] = data<Loose[]>(await getRawDataset({ dataset: 'weight', ...RANGE }, ctx))
    expect(raw.raw_json).toContain('"weight_kg":9007199254740993')
  })
})

describe('测量链：秘密边界', () => {
  it('账户/嵌套/编码秘密不落库；未分类字符串阻断整条并标 partial', async () => {
    const id = owner()
    const c = clock()
    const jobId = await sync(
      id,
      {
        ...baseData(),
        weight_list: [
          weight({
            // 秘密键名下的值即使形态“安全”也必须移除
            nested: {
              refresh_token: SYNTHETIC.refresh,
              pin_password: '123456',
              fine: 1,
              [SYNTHETIC.email]: 1,
            },
            ext_data: JSON.stringify({
              smi: 7,
              auth: { token: SYNTHETIC.token },
              deviceNameExt: SYNTHETIC.phone,
            }),
            copied: SYNTHETIC.email,
            // 已知字符串字段不做形态阻断，只能靠登录/账户响应收集到的秘密值精确匹配拦截
            app_ver: SYNTHETIC.token,
            device_id: SYNTHETIC.openId,
            // 登录名、明文密码、等价密码摘要（FitDays 登录用的 MD5 形式）
            created_at: SYNTHETIC.login,
            source: SYNTHETIC.password,
            adc_list: hashPassword(SYNTHETIC.password),
          }),
          weight({ data_id: 'w-note', measured_time: 1789300000, note: '今天状态不错' }),
        ],
        mystery_list: [{ x: 1 }],
      },
      c,
    )
    const dump = JSON.stringify(
      await Promise.all(
        [
          'raw_records',
          'raw_record_versions',
          'blocked_items',
          'sync_batches',
          'profiles',
          'devices',
          'sync_meta',
        ].map(async (t) => (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results),
      ),
    )
    for (const secret of [...Object.values(SYNTHETIC), hashPassword(SYNTHETIC.password)]) {
      expect(dump).not.toContain(secret)
    }
    for (const identity of ['AA:BB:CC:DD:EE:FF', '1990-01-01', 'example.invalid/p.png', '今天状态不错']) {
      expect(dump).not.toContain(identity)
    }
    // 秘密字段的路径（键名）可以记录用于审计，但值不能进入 raw
    const rawTexts = await env.DB.prepare(
      'SELECT raw_json, redacted_paths_json FROM raw_record_versions WHERE owner_id = ?',
    )
      .bind(id)
      .all<Loose>()
    expect(rawTexts.results.map((r) => r.raw_json).join('')).not.toContain('pin_password')
    expect(rawTexts.results.map((r) => r.redacted_paths_json).join('')).toContain('nested.<redacted-key>')
    const ctx = ctxFor(id, c)
    const raw = data<Loose[]>(await getRawDataset({ dataset: 'weight', ...RANGE }, ctx))
    expect(raw).toHaveLength(1)
    expect(raw[0].quality_flags).toContain('redacted')
    const blocked = await env.DB.prepare(
      'SELECT path, value_type, code FROM blocked_items WHERE batch_id = ?',
    )
      .bind(jobId)
      .all()
    expect(blocked.results).toEqual([{ path: 'note', value_type: 'string', code: 'UNCLASSIFIED_STRING' }])

    const status = data<Loose>(await getSyncStatus({}, ctx))
    expect(status.state).toBe('partial')
    expect(status.coverage).toBe('partial')
    expect(status.counts.blocked_last_batch).toBe(1)
    const meta = await env.DB.prepare('SELECT checkpoint_newest FROM sync_meta WHERE owner_id = ?')
      .bind(id)
      .first<Loose>()
    expect(meta.checkpoint_newest).toBeNull()

    expect(data<Loose[]>(await listDevices({}, ctx))).toEqual([
      { device_ref: expect.stringMatching(/^d_/), model: 'fixture-only', firmware: '1.0' },
    ])
    expect(data<Loose[]>(await listProfiles({}, ctx))).toEqual([
      { profile_ref: expect.stringMatching(/^p_/), label: '测试成员' },
    ])
  })
})

describe('测量链：版本、tombstone、关联与隔离', () => {
  it('修改追加版本并保留 first_seen 与旧 raw；缺席不等于删除；删除标记成为新版本', async () => {
    const id = owner()
    const c = clock()
    await sync(id, baseData(), c)
    const first = await env.DB.prepare(
      "SELECT id, first_seen_at FROM raw_records WHERE owner_id = ? AND source_record_id = 'w1'",
    )
      .bind(id)
      .first<Loose>()

    c.advance(DAY + 3600_000)
    const second = baseData()
    second.weight_list = [weight({ weight_kg: 69 }), ...second.weight_list.slice(1, 3)]
    await sync(id, second, c)
    const ctx = ctxFor(id, c)
    const summaries = data<Loose[]>(await getMeasurements(RANGE, ctx))
    expect(summaries.map((s) => s.metrics.weight_kg).sort()).toEqual([69, 72, 74])
    const again = await env.DB.prepare('SELECT first_seen_at, last_seen_at FROM raw_records WHERE id = ?')
      .bind(first.id)
      .first<Loose>()
    expect(again.first_seen_at).toBe(first.first_seen_at)
    expect(again.last_seen_at).toBeGreaterThan(first.first_seen_at)
    const versions = await env.DB.prepare(
      'SELECT raw_json FROM raw_record_versions WHERE raw_record_id = ? ORDER BY generation',
    )
      .bind(first.id)
      .all<Loose>()
    expect(versions.results.map((v) => JSON.parse(v.raw_json).weight_kg)).toEqual([70, 69])

    c.advance(DAY + 3600_000)
    const third = baseData()
    third.weight_list = [weight({ weight_kg: 69, is_deleted: 1 })]
    await sync(id, third, c)
    expect(
      data<Loose[]>(await getMeasurements(RANGE, ctx))
        .map((s) => s.metrics.weight_kg)
        .sort(),
    ).toEqual([72, 74])
    const tomb = data<Loose[]>(await getMeasurements({ ...RANGE, include_deleted: true }, ctx))
    expect(tomb.find((s) => s.metrics.weight_kg === 69).quality_flags).toContain('tombstone')
    await expect(
      env.DB.prepare('DELETE FROM raw_record_versions WHERE raw_record_id = ?').bind(first.id).run(),
    ).rejects.toThrow()
  })

  it('候选外键关联：单一匹配为 unverified，歧义不任取，缺失/不适用分开；orphan 可查；跨 owner 不可见', async () => {
    const id = owner()
    const c = clock()
    const extra = baseData()
    extra.impedance_list.push({ data_id: 'i1', measured_time: 1789344600, impedance: 999 } as Loose)
    extra.weight_list.push(
      weight({ data_id: 'w5', measured_time: 1789345000, imp_data_id: 'nope', balance_data_id: '' }),
    )
    await sync(id, extra, c)
    const ctx = ctxFor(id, c)

    const latest = data<Loose>(await getLatestMeasurementFull({}, ctx))
    expect(JSON.parse(latest.weight.raw_json).data_id).toBe('w5')
    const rel = Object.fromEntries(latest.relations.map((r: Loose) => [r.dataset, r]))
    expect(rel.impedance.status).toBe('missing')
    expect(rel.balance.status).toBe('not_applicable')
    expect(rel.gravity.status).toBe('unverified')
    expect(rel.hr.status).toBe('not_applicable')

    const full = data<Loose[]>(await getMeasurements({ ...RANGE, detail: 'full' }, ctx))
    const w1 = full.find((m) => JSON.parse(m.weight.raw_json).data_id === 'w1')
    const imp = w1.relations.find((r: Loose) => r.dataset === 'impedance')
    expect(imp.status).toBe('ambiguous')
    expect(imp.records).toHaveLength(2)

    const impedance = data<Loose[]>(await getRawDataset({ dataset: 'impedance', ...RANGE }, ctx))
    expect(impedance.map((r) => JSON.parse(r.raw_json).data_id).sort()).toEqual(['i1', 'i1', 'orphan-i'])
    const w1Ref = w1.weight.record_ref
    const related = data<Loose[]>(
      await getRawDataset({ dataset: 'impedance', ...RANGE, measurement_ref: w1Ref }, ctx),
    )
    expect(related).toHaveLength(2)

    const other = owner()
    await sync(other, { weight_list: [weight({ data_id: 'other-w', weight_kg: 99 })] }, c)
    const mine = data<Loose[]>(await getMeasurements(RANGE, ctx))
    expect(mine.some((s) => s.metrics.weight_kg === 99)).toBe(false)
    const otherVersion = await env.DB.prepare('SELECT id FROM raw_record_versions WHERE owner_id = ?')
      .bind(other)
      .first<Loose>()
    expect(await rejects(getRawRecordChunk({ version_ref: otherVersion.id, chunk_index: 0 }, ctx))).toBe(
      'NOT_FOUND',
    )
  })
})

describe('测量链：大记录、分页快照与发布原子性', () => {
  it('超过 256 KiB 的单条记录分块存储，按块回取后 SHA-256 一致', async () => {
    const id = owner()
    const c = clock()
    const blob = Array.from({ length: 60_000 }, (_, i) => 10_000 + i)
    await sync(id, { weight_list: [weight({ blob })] }, c)
    const stored = await env.DB.prepare(
      'SELECT chunk_count, raw_json FROM raw_record_versions WHERE owner_id = ?',
    )
      .bind(id)
      .first<Loose>()
    expect(stored.raw_json).toBeNull()
    expect(stored.chunk_count).toBe(2)

    const ctx = ctxFor(id, c)
    const [record] = data<Loose[]>(await getRawDataset({ dataset: 'weight', ...RANGE }, ctx))
    expect(record.complete).toBe(false)
    expect(record.raw_json).toBeNull()
    const parts: Uint8Array[] = []
    let count = 1
    for (let i = 0; i < count; i++) {
      const chunk = data<Loose>(
        await getRawRecordChunk({ version_ref: record.chunk_ref, chunk_index: i }, ctx),
      )
      count = chunk.chunk_count
      const bytes = Uint8Array.from(atob(chunk.data_base64), (ch) => ch.charCodeAt(0))
      expect(await sha256Hex(bytes)).toBe(chunk.chunk_sha256)
      parts.push(bytes)
    }
    const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const p of parts) {
      whole.set(p, offset)
      offset += p.length
    }
    expect(await sha256Hex(whole)).toBe(record.raw_hash)
    expect(JSON.parse(new TextDecoder().decode(whole)).blob).toHaveLength(60_000)
    expect(await rejects(getRawRecordChunk({ version_ref: record.chunk_ref, chunk_index: count }, ctx))).toBe(
      'NOT_FOUND',
    )
  })

  it('游标跨页不重不漏，修订期间旧游标读同一快照；篡改/他人/过期游标被拒', async () => {
    const id = owner()
    const c = clock()
    const list = Array.from({ length: 30 }, (_, i) =>
      weight({ data_id: `p${i}`, measured_time: 1789000000 + i * 3600, weight_kg: 60 + i, ext_data: null }),
    )
    await sync(id, { weight_list: list }, c)
    const ctx = ctxFor(id, c)
    const first = await getMeasurements({ ...RANGE, limit: 7 }, ctx)
    expect(first.nextCursor).toBeTruthy()

    c.advance(61_000)
    const changed = list.map((w) => (w.data_id === 'p25' ? { ...w, weight_kg: 1 } : w))
    changed.push(
      weight({
        data_id: 'p-new',
        measured_time: 1789000000 + 26 * 3600 + 60,
        weight_kg: 500,
        ext_data: null,
      }),
    )
    await sync(id, { weight_list: changed }, c, {}, 'incremental')

    const seen = [...data<Loose[]>(first)]
    let cursor = first.nextCursor ?? undefined
    while (cursor) {
      const page = await getMeasurements({ ...RANGE, limit: 7, cursor }, ctx)
      seen.push(...data<Loose[]>(page))
      cursor = page.nextCursor ?? undefined
    }
    expect(new Set(seen.map((s) => s.record_ref)).size).toBe(30)
    expect(seen).toHaveLength(30)
    expect(seen.some((s) => s.metrics.weight_kg === 1 || s.metrics.weight_kg === 500)).toBe(false)
    const fresh = data<Loose[]>(await getMeasurements({ ...RANGE, limit: 200 }, ctx))
    expect(fresh).toHaveLength(31)

    const tampered = `${first.nextCursor?.slice(0, -2)}xx`
    expect(await rejects(getMeasurements({ ...RANGE, limit: 7, cursor: tampered }, ctx))).toBe(
      'CURSOR_INVALID',
    )
    expect(await rejects(getMeasurements({ ...RANGE, limit: 8, cursor: first.nextCursor ?? '' }, ctx))).toBe(
      'CURSOR_INVALID',
    )
    expect(
      await rejects(
        getMeasurements({ ...RANGE, limit: 7, cursor: first.nextCursor ?? '' }, ctxFor(owner(), c)),
      ),
    ).toBe('CURSOR_INVALID')
    c.advance(2 * 3600_000)
    expect(await rejects(getMeasurements({ ...RANGE, limit: 7, cursor: first.nextCursor ?? '' }, ctx))).toBe(
      'CURSOR_EXPIRED',
    )
  })

  it('响应字节预算先于 limit 生效并返回游标', async () => {
    const id = owner()
    const c = clock()
    const blob = Array.from({ length: 9_000 }, (_, i) => 100_000 + i)
    const list = Array.from({ length: 6 }, (_, i) =>
      weight({ data_id: `b${i}`, measured_time: 1789000000 + i, blob, ext_data: null }),
    )
    await sync(id, { weight_list: list }, c)
    const page = await getRawDataset({ dataset: 'weight', ...RANGE, limit: 6 }, ctxFor(id, c))
    expect(data<Loose[]>(page).length).toBeLessThan(6)
    expect(page.nextCursor).toBeTruthy()
  })

  it('发布前失败：旧快照仍可见、未发布暂存被清除、stale 与脱敏错误码', async () => {
    const id = owner()
    const c = clock()
    await sync(id, baseData(), c)
    c.advance(DAY + 3600_000)
    const next = baseData()
    next.weight_list = [weight({ weight_kg: 55 })]
    const jobId = await sync(id, next, c, {
      beforePublish: async () => {
        throw new Error('simulated crash')
      },
    })
    const ctx = ctxFor(id, c)
    const outcome = await getMeasurements(RANGE, ctx)
    expect(data<Loose[]>(outcome).map((s) => s.metrics.weight_kg)).not.toContain(55)
    expect(outcome.stale).toBe(true)
    const leftovers = await env.DB.prepare('SELECT COUNT(*) AS n FROM raw_record_versions WHERE batch_id = ?')
      .bind(jobId)
      .first<Loose>()
    expect(leftovers.n).toBe(0)
    const status = data<Loose>(await getSyncStatus({}, ctx))
    expect(status.state).toBe('failed')
    expect(status.error_code).toBe('STORAGE_FAILED')
  })

  it('fencing：lease 被新任务接管后，旧任务发布整体回滚且不可见', async () => {
    const id = owner()
    const c = clock()
    await sync(id, baseData(), c)
    c.advance(DAY + 3600_000)
    const next = baseData()
    next.weight_list = [weight({ weight_kg: 33 })]
    const jobId = await sync(id, next, c, {
      beforePublish: async () => {
        await env.DB.prepare(
          "UPDATE sync_lease SET generation = generation + 1, holder = 'newer-job' WHERE owner_id = ?",
        )
          .bind(id)
          .run()
      },
    })
    const ctx = ctxFor(id, c)
    expect(data<Loose[]>(await getMeasurements(RANGE, ctx)).map((s) => s.metrics.weight_kg)).not.toContain(33)
    const batch = await env.DB.prepare('SELECT state FROM sync_batches WHERE id = ?')
      .bind(jobId)
      .first<Loose>()
    expect(batch.state).toBe('failed')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM guard').first<Loose>()).n).toBe(0)
  })
})

describe('审查回归：同步与测量输出', () => {
  it('被 cron 接管的旧尝试晚到发布：新尝试的数据与状态不受影响，旧尝试不写错误状态', async () => {
    const id = owner()
    const c = clock()
    await sync(id, baseData(), c)
    c.advance(DAY + 3600_000)
    const next = baseData()
    next.weight_list = [weight({ weight_kg: 66 })]
    const up = upstream(() => syncBody(next))
    const cronEnv = { ...env, OWNER_ID: id } as Env
    const job = await requestRefresh(env.DB, id, 'full', c.now())
    await runSyncJob(env, job.job_id, deps(up.fetch, c.now), {
      secrets: syntheticSecrets(),
      beforePublish: async () => {
        // 模拟 waitUntil 被截断后 lease 过期，cron 回收并以新 batch 重跑成功。
        await env.DB.prepare('UPDATE sync_lease SET expires_at = 0 WHERE owner_id = ?').bind(id).run()
        c.advance(1000)
        await scheduledSync(cronEnv, deps(up.fetch, c.now), { secrets: syntheticSecrets() })
      },
    })
    const batches = await env.DB.prepare(
      'SELECT id, state FROM sync_batches WHERE owner_id = ? ORDER BY created_at',
    )
      .bind(id)
      .all<Loose>()
    expect(batches.results.find((b: Loose) => b.id === job.job_id).state).toBe('failed')
    expect(batches.results.at(-1).state).toBe('published')
    const ctx = ctxFor(id, c)
    const status = data<Loose>(await getSyncStatus({}, ctx))
    expect(status.error_code).toBeNull()
    expect(status.state).toBe('published')
    expect(data<Loose[]>(await getMeasurements(RANGE, ctx)).map((s) => s.metrics.weight_kg)).toContain(66)
  })

  it('没有检查点时（首批 partial）incremental 请求也受冷却约束，不会反复全量拉取', async () => {
    const id = owner()
    const c = clock()
    await sync(id, { weight_list: [weight({ data_id: 'n', note: '自由文本' })] }, c)
    expect(await rejects(requestRefresh(env.DB, id, 'incremental', c.now() + 5_000))).toBe('SYNC_IN_PROGRESS')
    c.advance(11 * 60_000)
    expect((await requestRefresh(env.DB, id, 'incremental', c.now())).state).toBe('queued')
  })

  it('ext_data 很大时完整体测不超限：不内联 ext 原文/解析，给出 chunk_ref', async () => {
    const id = owner()
    const c = clock()
    const ext = JSON.stringify({ smi: 7, samples: Array.from({ length: 20_000 }, (_, i) => i) })
    await sync(id, { weight_list: [weight({ ext_data: ext })] }, c)
    const ctx = ctxFor(id, c)
    const latest = data<Loose>(await getLatestMeasurementFull({}, ctx))
    expect(latest.complete).toBe(false)
    expect(latest.ext_data_raw).toBeNull()
    expect(latest.weight.chunk_ref).toBeTruthy()
    expect(new TextEncoder().encode(JSON.stringify(latest)).byteLength).toBeLessThan(256 * 1024)
  })

  it('account 中的普通字段（如 updated_at）不会被当作秘密误删；__proto__ 键不打断同步', async () => {
    const id = owner()
    const c = clock()
    const body = JSON.parse(
      syncBody({ weight_list: [weight({ updated_at: '2026-09-14 10:00:00', constructor: 1 })] }),
    )
    body.data.account.updated_at = '2026-09-14 10:00:00'
    const text = JSON.stringify(body).replace('"constructor":1', '"constructor":1,"__proto__":{"k":2}')
    const up = upstream(() => text)
    const job = await requestRefresh(env.DB, id, 'full', c.now())
    await runSyncJob(env, job.job_id, deps(up.fetch, c.now), { secrets: syntheticSecrets() })
    const [raw] = data<Loose[]>(await getRawDataset({ dataset: 'weight', ...RANGE }, ctxFor(id, c)))
    expect(raw.raw_json).toContain('"updated_at":"2026-09-14 10:00:00"')
    expect(raw.raw_json).toContain('"__proto__":{"k":2}')
    expect(raw.quality_flags).not.toContain('redacted')
  })
})

describe('同步队列与冷却', () => {
  it('活动任务复用、增量冷却、全量冷却、cron 回收过期暂存并重跑', async () => {
    const id = owner()
    const c = clock()
    const a = await requestRefresh(env.DB, id, 'incremental', c.now())
    const b = await requestRefresh(env.DB, id, 'full', c.now())
    expect(b.job_id).toBe(a.job_id)
    const up = upstream(() => syncBody(baseData()))
    await runSyncJob(env, a.job_id, deps(up.fetch, c.now), { secrets: syntheticSecrets() })
    expect(await rejects(requestRefresh(env.DB, id, 'full', c.now()))).toBe('SYNC_IN_PROGRESS')
    c.advance(61_000)
    const inc = await requestRefresh(env.DB, id, 'incremental', c.now())
    expect((await requestRefresh(env.DB, id, 'incremental', c.now() + 1)).job_id).toBe(inc.job_id)
    expect(inc.state).toBe('queued')

    // 模拟 waitUntil 被截断：任务停在 staging 且 lease 过期，cron 回收后重跑成功。
    await env.DB.prepare("UPDATE sync_batches SET state = 'staging', generation = 99 WHERE id = ?")
      .bind(inc.job_id)
      .run()
    await env.DB.prepare(
      'INSERT OR REPLACE INTO sync_lease (owner_id, generation, holder, expires_at) VALUES (?, 99, ?, 0)',
    )
      .bind(id, inc.job_id)
      .run()
    const cronEnv = { ...env, OWNER_ID: id } as Env
    await scheduledSync(cronEnv, deps(up.fetch, c.now), { secrets: syntheticSecrets() })
    const batches = await env.DB.prepare(
      'SELECT id, state, attempts FROM sync_batches WHERE owner_id = ? ORDER BY created_at, attempts',
    )
      .bind(id)
      .all<Loose>()
    // 被截断的尝试记为失败；重试是新的 batch，成功发布。
    expect(batches.results.find((b: Loose) => b.id === inc.job_id).state).toBe('failed')
    const retry = batches.results.find((b: Loose) => b.id !== inc.job_id && b.id !== a.job_id)
    expect(retry.state).toBe('published')
    expect(retry.attempts).toBe(1)
  })
})
