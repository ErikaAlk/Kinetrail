// MCP 契约 schema 的 TS 实现，逐项对应 research/build-contract.py。
// tests/contract.test.ts 断言两者完全一致；改契约时先改生成器并重跑，再改这里。

type Schema = Record<string, unknown>

const obj = (props: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
})
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` })
const arr = (item: Schema, maximum = 200, minimum = 0): Schema => ({
  type: 'array',
  items: item,
  minItems: minimum,
  maxItems: maximum,
})
const enumOf = (...values: string[]): Schema => ({ enum: values })
const string = (maximum = 256): Schema => ({ type: 'string', minLength: 1, maxLength: maximum })
const number = (minimum = 0): Schema => ({ type: 'number', minimum })
const integer = (minimum = 0): Schema => ({ type: 'integer', minimum })
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] })

const ID = string(128)
const TEXT = string(4096)
const TIME: Schema = { type: 'string', format: 'date-time' }
const BOOL: Schema = { type: 'boolean' }
const original = () =>
  obj({ value: { anyOf: [{ type: 'number' }, string(80)] }, unit: string(40) }, ['value', 'unit'])

export const defs: Record<string, Schema> = {}
defs.Set = obj({
  load_original: original(),
  distance_original: original(),
  speed_original: original(),
  assistance_value: number(),
  assistance_unit: enumOf('kg', 'lb'),
  set_type: enumOf('warmup', 'working', 'drop', 'failure', 'other'),
  load_value: number(),
  load_unit: enumOf('kg', 'lb'),
  load_basis: enumOf('total_external', 'per_hand', 'bodyweight', 'assisted', 'unknown'),
  reps: integer(),
  duration_seconds: integer(),
  distance_value: number(),
  distance_unit: enumOf('m', 'km', 'mi'),
  speed: number(),
  speed_unit: enumOf('m/s', 'km/h', 'mph'),
  incline_pct: { type: 'number', minimum: -100, maximum: 100 },
  resistance: { anyOf: [number(), string(80)] },
  resistance_unit: string(40),
  power_watts: number(),
  rpe: { type: 'number', minimum: 0, maximum: 10 },
  rir: number(),
  heart_rate_avg: number(),
  heart_rate_max: number(),
  notes: TEXT,
})
const entryProps: Record<string, Schema> = {
  exercise_name_raw: string(120),
  exercise_id: ID,
  category: enumOf('strength', 'cardio', 'mobility', 'other'),
  equipment_ref: ID,
  equipment_label: string(120),
  facility: string(120),
  sets: arr(ref('Set'), 100, 1),
  notes: TEXT,
}
defs.Entry = obj(entryProps, ['exercise_name_raw', 'category', 'sets'])
defs.StoredEntry = obj(
  {
    ...entryProps,
    normalization_version: ID,
    normalized_sets: arr(
      obj(
        {
          load_kg: nullable(number()),
          assistance_kg: nullable(number()),
          distance_m: nullable(number()),
          speed_mps: nullable(number()),
          quality_flags: arr(ID),
        },
        ['load_kg', 'assistance_kg', 'distance_m', 'speed_mps', 'quality_flags'],
      ),
      100,
      1,
    ),
  },
  ['exercise_name_raw', 'category', 'sets', 'normalization_version', 'normalized_sets'],
)
defs.Receipt = obj(
  {
    session_id: ID,
    event_id: ID,
    entry_ids: arr(ID, 100),
    revision: integer(1),
    committed_at: TIME,
    idempotency_key: ID,
  },
  ['session_id', 'event_id', 'entry_ids', 'revision', 'committed_at', 'idempotency_key'],
)
defs.Session = obj(
  {
    session_id: ID,
    status: enumOf('open', 'finalized'),
    revision: integer(),
    started_at: TIME,
    ended_at: nullable(TIME),
    timezone: string(80),
    facility: nullable(string(120)),
    selection_required: BOOL,
    duration_seconds: nullable(integer()),
    duration_source: enumOf('user_reported', 'timestamps', 'unknown'),
    overall_rpe: nullable({ type: 'number', minimum: 0, maximum: 10 }),
    notes: nullable(TEXT),
  },
  [
    'session_id',
    'status',
    'revision',
    'started_at',
    'ended_at',
    'timezone',
    'facility',
    'selection_required',
    'duration_seconds',
    'duration_source',
    'overall_rpe',
    'notes',
  ],
)
defs.Workout = obj(
  {
    session: ref('Session'),
    entries: arr(
      obj(
        {
          entry_id: ID,
          version: integer(1),
          supersedes_version: nullable(integer(1)),
          state: enumOf('active', 'retracted'),
          occurred_at: TIME,
          raw_text: TEXT,
          entry: ref('StoredEntry'),
        },
        ['entry_id', 'version', 'supersedes_version', 'state', 'occurred_at', 'raw_text', 'entry'],
      ),
      100,
    ),
    entries_complete: BOOL,
    entry_cursor: nullable(string(2048)),
  },
  ['session', 'entries', 'entries_complete', 'entry_cursor'],
)
defs.RawRecord = obj(
  {
    record_ref: ID,
    version_ref: ID,
    dataset: ID,
    profile_ref: ID,
    raw_hash: string(64),
    byte_length: integer(),
    raw_json: nullable({ type: 'string', maxLength: 200000 }),
    complete: BOOL,
    chunk_ref: nullable(ID),
    is_deleted: nullable(BOOL),
    quality_flags: arr(ID),
  },
  [
    'record_ref',
    'version_ref',
    'dataset',
    'profile_ref',
    'raw_hash',
    'byte_length',
    'raw_json',
    'complete',
    'chunk_ref',
    'is_deleted',
    'quality_flags',
  ],
)
defs.Measurement = obj(
  {
    weight: ref('RawRecord'),
    ext_data_raw: nullable({ type: 'string', maxLength: 200000 }),
    ext_data_parsed: {},
    ext_parse_status: enumOf('missing', 'null', 'empty', 'ok', 'invalid', 'blocked'),
    relations: arr(
      obj(
        {
          dataset: ID,
          status: enumOf('exact', 'missing', 'ambiguous', 'unverified', 'not_applicable'),
          records: arr(ref('RawRecord'), 50),
          next_cursor: nullable(string(2048)),
        },
        ['dataset', 'status', 'records', 'next_cursor'],
      ),
      8,
    ),
    complete: BOOL,
  },
  ['weight', 'ext_data_raw', 'ext_data_parsed', 'ext_parse_status', 'relations', 'complete'],
)
defs.Summary = obj(
  {
    record_ref: ID,
    profile_ref: ID,
    measured_at: nullable(TIME),
    local_date: nullable({ type: 'string', format: 'date' }),
    metrics: { type: 'object', additionalProperties: nullable({ type: 'number' }) },
    quality_flags: arr(ID),
  },
  ['record_ref', 'profile_ref', 'measured_at', 'local_date', 'metrics', 'quality_flags'],
)
defs.Trend = obj(
  {
    start: TIME,
    end: TIME,
    interval: enumOf('day', 'week', 'month'),
    timezone: string(80),
    formula_version: ID,
    points: arr(
      obj(
        {
          period_start: TIME,
          period_end: TIME,
          group_key: ID,
          metric: ID,
          value: nullable({ type: 'number' }),
          unit: string(40),
          samples: integer(),
          valid_days: integer(),
          missing_count: integer(),
          quality_flags: arr(ID),
        },
        [
          'period_start',
          'period_end',
          'group_key',
          'metric',
          'value',
          'unit',
          'samples',
          'valid_days',
          'missing_count',
          'quality_flags',
        ],
      ),
      1000,
    ),
  },
  ['start', 'end', 'interval', 'timezone', 'formula_version', 'points'],
)
defs.SyncStatus = obj(
  {
    last_success_at: nullable(TIME),
    last_attempt_at: nullable(TIME),
    batch_id: nullable(ID),
    state: enumOf('empty', 'staging', 'published', 'partial', 'failed'),
    coverage: enumOf('unknown', 'partial', 'verified_window'),
    counts: { type: 'object', additionalProperties: integer() },
    error_code: nullable(ID),
  },
  ['last_success_at', 'last_attempt_at', 'batch_id', 'state', 'coverage', 'counts', 'error_code'],
)
defs.Error = obj(
  {
    code: ID,
    message: TEXT,
    retryable: BOOL,
    persistence: enumOf('not_applicable', 'not_committed', 'unknown'),
    retry_after_seconds: integer(),
    current_revision: integer(),
  },
  ['code', 'message', 'retryable', 'persistence'],
)

const output = (data: Schema, write = false): Schema =>
  obj(
    {
      schema_version: { const: '1' },
      request_id: ID,
      status: enumOf('ok', 'empty', 'error'),
      data: nullable(data),
      error: nullable(ref('Error')),
      stale: BOOL,
      synced_at: nullable(TIME),
      next_cursor: nullable(string(2048)),
      persistence: write ? enumOf('committed', 'not_committed', 'unknown') : { const: 'not_applicable' },
    },
    [
      'schema_version',
      'request_id',
      'status',
      'data',
      'error',
      'stale',
      'synced_at',
      'next_cursor',
      'persistence',
    ],
  )

const rangeProps: Record<string, Schema> = {
  start: TIME,
  end: TIME,
  timezone: string(80),
  limit: { type: 'integer', minimum: 1, maximum: 200 },
  cursor: string(2048),
}
const bodyProps = { ...rangeProps, profile_ref: ID, include_deleted: BOOL }
const idem: Record<string, Schema> = {
  idempotency_key: { type: 'string', minLength: 16, maxLength: 128 },
  expected_revision: integer(),
}
const trendInputs = { ...rangeProps, interval: enumOf('day', 'week', 'month') }
const pageProps = { limit: rangeProps.limit as Schema, cursor: rangeProps.cursor as Schema }

export type Scope = 'body:read' | 'body:sync' | 'workout:read' | 'workout:write'

export interface ContractTool {
  name: string
  inputSchema: Schema
  outputSchema: Schema
  securitySchemes: { type: 'oauth2'; scopes: Scope[] }[]
  _meta: { securitySchemes: { type: 'oauth2'; scopes: Scope[] }[] }
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    openWorldHint: false
    idempotentHint: boolean
  }
}

export const contractTools: ContractTool[] = []
const tool = (
  name: string,
  scopes: Scope[],
  inputs: Record<string, Schema>,
  required: string[],
  data: Schema,
  write = false,
  destructive = false,
  idempotent = true,
) => {
  contractTools.push({
    name,
    inputSchema: obj(inputs, required),
    outputSchema: output(data, write),
    securitySchemes: [{ type: 'oauth2', scopes }],
    _meta: { securitySchemes: [{ type: 'oauth2', scopes }] },
    annotations: {
      readOnlyHint: !write,
      destructiveHint: destructive,
      openWorldHint: false,
      idempotentHint: idempotent,
    },
  })
}

tool(
  'get_latest_measurement_full',
  ['body:read'],
  { profile_ref: ID, include_deleted: BOOL },
  [],
  ref('Measurement'),
)
tool(
  'get_measurements',
  ['body:read'],
  { ...bodyProps, detail: enumOf('summary', 'full') },
  ['start', 'end'],
  arr({ anyOf: [ref('Measurement'), ref('Summary')] }),
)
tool(
  'get_raw_dataset',
  ['body:read'],
  {
    ...bodyProps,
    dataset: enumOf('weight', 'impedance', 'hr', 'balance', 'gravity', 'height', 'rulers', 'skip'),
    measurement_ref: ID,
  },
  ['dataset', 'start', 'end'],
  arr(ref('RawRecord')),
)
tool(
  'get_raw_record_chunk',
  ['body:read'],
  { version_ref: ID, chunk_index: integer() },
  ['version_ref', 'chunk_index'],
  obj(
    {
      data_base64: string(40000),
      chunk_index: integer(),
      chunk_count: integer(1),
      record_sha256: string(64),
      chunk_sha256: string(64),
    },
    ['data_base64', 'chunk_index', 'chunk_count', 'record_sha256', 'chunk_sha256'],
  ),
)
tool('get_sync_status', ['body:read'], {}, [], ref('SyncStatus'))
for (const [name, fields] of [
  ['list_profiles', { profile_ref: ID, label: string(80) }],
  ['list_devices', { device_ref: ID, model: nullable(string(120)), firmware: nullable(string(120)) }],
] as const) {
  tool(name, ['body:read'], pageProps, [], arr(obj(fields, Object.keys(fields))))
}
tool(
  'get_trend',
  ['body:read'],
  {
    ...trendInputs,
    profile_ref: ID,
    metrics: arr(enumOf('weight_kg', 'body_fat_pct', 'fat_mass_kg', 'fat_free_mass_kg'), 4, 1),
    daily_reducer: { const: 'median' },
  },
  ['start', 'end'],
  ref('Trend'),
)
tool('get_open_workout_sessions', ['workout:read'], pageProps, [], arr(ref('Session')))
tool(
  'get_workout_history',
  ['workout:read'],
  {
    ...rangeProps,
    session_id: ID,
    entry_cursor: string(2048),
    exercise_id: ID,
    equipment_ref: ID,
    status: enumOf('open', 'finalized'),
    include_superseded: BOOL,
  },
  ['start', 'end'],
  arr(ref('Workout')),
)
tool(
  'get_training_trend',
  ['workout:read'],
  { ...trendInputs, exercise_id: ID, equipment_ref: ID },
  ['start', 'end'],
  ref('Trend'),
)
tool(
  'get_progress_overview',
  ['body:read', 'workout:read'],
  { ...trendInputs, profile_ref: ID },
  ['start', 'end'],
  obj({ body: ref('Trend'), training: ref('Trend') }, ['body', 'training']),
)
tool('get_write_receipt', ['workout:read'], { idempotency_key: ID }, ['idempotency_key'], ref('Receipt'))
tool(
  'start_workout_session',
  ['workout:write'],
  { ...idem, started_at: TIME, timezone: string(80), facility: string(120), raw_text: TEXT },
  ['idempotency_key', 'expected_revision', 'started_at', 'timezone', 'raw_text'],
  ref('Receipt'),
  true,
)
tool(
  'record_workout_event',
  ['workout:write'],
  {
    ...idem,
    session_id: ID,
    occurred_at: TIME,
    timezone: string(80),
    raw_text: TEXT,
    completion: { const: 'completed' },
    entries: arr(ref('Entry'), 20, 1),
  },
  ['idempotency_key', 'expected_revision', 'occurred_at', 'timezone', 'raw_text', 'completion', 'entries'],
  ref('Receipt'),
  true,
)
tool(
  'finalize_workout_session',
  ['workout:write'],
  {
    ...idem,
    session_id: ID,
    ended_at: TIME,
    raw_text: TEXT,
    duration_seconds: integer(),
    overall_rpe: { type: 'number', minimum: 0, maximum: 10 },
    notes: TEXT,
  },
  ['idempotency_key', 'expected_revision', 'session_id', 'ended_at', 'raw_text'],
  ref('Receipt'),
  true,
  true,
)
tool(
  'reopen_workout_session',
  ['workout:write'],
  { ...idem, session_id: ID, raw_text: TEXT },
  ['idempotency_key', 'expected_revision', 'session_id', 'raw_text'],
  ref('Receipt'),
  true,
  true,
)
tool(
  'amend_workout_entry',
  ['workout:write'],
  {
    ...idem,
    session_id: ID,
    entry_id: ID,
    raw_text: TEXT,
    replacement: ref('Entry'),
    state: enumOf('active', 'retracted'),
  },
  ['idempotency_key', 'expected_revision', 'session_id', 'entry_id', 'raw_text', 'replacement', 'state'],
  ref('Receipt'),
  true,
  true,
)

/** 把 `#/$defs/X` 引用展开成独立 schema，宿主拿到的 descriptor 不含任何 $ref。 */
export function inlineRefs(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(inlineRefs)
  if (schema === null || typeof schema !== 'object') return schema
  const record = schema as Record<string, unknown>
  if (typeof record.$ref === 'string') {
    const name = record.$ref.replace('#/$defs/', '')
    const target = defs[name]
    if (!target) throw new Error(`unknown $ref ${record.$ref}`)
    return inlineRefs(target)
  }
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, inlineRefs(v)]))
}
