// 19 个工具的中文标题、描述与处理函数。schema/annotations/scope 来自 schemas.ts（契约）。

import type { ToolDefinition } from './mcp'
import { KtError } from './util'

const BIA_NOTE = '体脂秤 BIA 数值适合看趋势，不是医疗诊断。'
const RANGE_NOTE = 'start/end 为带时区偏移的 RFC3339，半开区间 [start,end)。'

const pending = async (): Promise<never> => {
  throw new KtError('STORAGE_FAILED', { category: 'not_implemented' })
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_latest_measurement_full',
    title: '最新完整体测',
    description: `读取本地镜像中最新一次有效体测的完整原始记录，含 ext_data 原文与解析结果、阻抗/心率/平衡/重心的候选关联记录。只读，不访问 FitDays；需要新数据时先调用 refresh_data。${BIA_NOTE}`,
    handler: pending,
  },
  {
    name: 'get_measurements',
    title: '体测记录',
    description: `按时间范围分页读取体测。默认 summary；full 每页最多 25 条。默认排除 FitDays 标记删除的记录，include_deleted=true 可查看 tombstone。${RANGE_NOTE}${BIA_NOTE}`,
    handler: pending,
  },
  {
    name: 'get_raw_dataset',
    title: '原始数据集',
    description: `专家模式：分页读取脱敏后的原始测量记录（weight/impedance/hr/balance/gravity/height/rulers/skip），保留未知字段；不含账户认证字段。measurement_ref 可取某次称重的关联记录。${RANGE_NOTE}`,
    handler: pending,
  },
  {
    name: 'get_raw_record_chunk',
    title: '原始记录分块',
    description: '按固定版本分块读取超过响应上限的原始记录，每块附整条与分块 SHA-256，拼接后应校验整条哈希。',
    handler: pending,
  },
  {
    name: 'get_sync_status',
    title: '同步状态',
    description: '返回最后成功同步时间、最近尝试、覆盖范围、各数据集计数与脱敏错误码。',
    handler: pending,
  },
  {
    name: 'list_profiles',
    title: '测量成员',
    description: '列出 FitDays 账户下的测量成员 profile_ref 与名称，用于其他体测工具的 profile_ref 参数。',
    handler: pending,
  },
  {
    name: 'list_devices',
    title: '测量设备',
    description: '列出设备型号与固件版本，不含 MAC、序列号等标识。',
    handler: pending,
  },
  {
    name: 'get_trend',
    title: '体测趋势',
    description: `体重、体脂率、脂肪量、去脂体重趋势。先按自然日（默认 Asia/Shanghai）取当日中位数，再对周期内有数据的日等权平均；脂肪量按单次测量先算再聚合。group_key：period=周期值，ma7=最近 7 个日历日均值（仅 interval=day），pop_change/pop_change_pct=与上一周期对比（仅 week/month）。只描述观察结果，不作因果推断。${RANGE_NOTE}${BIA_NOTE}`,
    handler: pending,
  },
  {
    name: 'refresh_data',
    title: '刷新 FitDays 数据',
    description:
      '从 FitDays 只读拉取数据并更新 Kinetrail 本地镜像，不会写入或删除 FitDays 数据。返回同步任务状态：queued 只表示已接受，不代表数据已更新，结果用 get_sync_status 查询。incremental 冷却 60 秒，full 冷却 24 小时。',
    handler: pending,
  },
  {
    name: 'get_open_workout_sessions',
    title: '未结束的训练会话',
    description:
      '列出未结束的训练会话及 revision。记录训练前先调用，按返回的 session_id 与 revision 写入；selection_required=true 或存在多个候选时先向用户确认。',
    handler: pending,
  },
  {
    name: 'get_workout_history',
    title: '训练历史',
    description: `分页读取已保存的训练事实：逐组力量数据、有氧数据、用户原话、会话总结和修订版本。分析历史时以此为准，不依赖聊天记忆。include_superseded=true 返回被修订或撤回的旧版本。${RANGE_NOTE}`,
    handler: pending,
  },
  {
    name: 'get_training_trend',
    title: '训练趋势',
    description: `训练会话数、有效训练日、组数、训练量（Σ kg×次数）、Epley 估算 1RM（估算值，非实测）与有氧时长/距离趋势。力量指标按“动作+场馆+器械+负重口径”分组，不同器械不合并。${RANGE_NOTE}`,
    handler: pending,
  },
  {
    name: 'get_progress_overview',
    title: '体测与训练概览',
    description: `同一时间窗并列返回体测趋势与训练总体趋势，附样本数与计算口径；只描述同期观察结果，不声称因果。${RANGE_NOTE}${BIA_NOTE}`,
    handler: pending,
  },
  {
    name: 'get_write_receipt',
    title: '写入收据',
    description:
      '按 idempotency_key 查询训练写入收据，用于超时或无法确认是否保存时。查不到只表示目前没有已提交的收据，不能据此断定请求永远不会提交。',
    handler: pending,
  },
  {
    name: 'start_workout_session',
    title: '开始训练会话',
    description:
      '用户到场或明确开始训练时建立空的 open 会话，不记录任何已完成的组。expected_revision 固定为 0。只有返回 persistence=committed 才能说已保存。',
    handler: pending,
  },
  {
    name: 'record_workout_event',
    title: '记录已完成训练',
    description:
      '只在用户明确报告自己已经完成的训练时调用；计划、建议、假设、引用他人、否定或未确认完成的内容不得调用。raw_text 填用户与本次训练直接相关的原话；逐组填写，缺失的负重/次数留空，不要补值。先用 get_open_workout_sessions 取得 session_id 与 revision；没有 open 会话时省略 session_id 且 expected_revision=0。每个写请求只生成一次 idempotency_key，超时重试必须复用同键同参数。只有返回 persistence=committed 才能告诉用户已保存；失败时明确说本次未持久化。',
    handler: pending,
  },
  {
    name: 'finalize_workout_session',
    title: '结束训练会话',
    description:
      '用户明确说练完或结束时结束会话，可附用户报告的总时长、整体 RPE 和备注。结束后继续记录需要 reopen_workout_session 或新会话。',
    handler: pending,
  },
  {
    name: 'reopen_workout_session',
    title: '重新打开训练会话',
    description: '用户明确要求继续一个已结束的训练会话时重新打开它。',
    handler: pending,
  },
  {
    name: 'amend_workout_entry',
    title: '修正训练记录',
    description:
      '纠正或撤回已保存的动作：生成新版本并保留旧值，不物理删除。replacement 为完整的更正后动作；state=retracted 表示撤回（该动作不再计入统计）。',
    handler: pending,
  },
]
