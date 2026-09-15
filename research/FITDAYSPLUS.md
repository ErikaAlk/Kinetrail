# FitDays / FitDays+ 登录并发与 FitDays+ 接口还原（2026-09-15）

用户反馈：Kinetrail 每次同步都会把手机上的 FitDays 顶下线，考虑迁移到 FitDays+。本文记录验证过程与结论，供 FitDays+ 适配器实现时使用。

## 结论

1. **FitDays 与 FitDays+ 都是同一账号只保留最后一次登录的 token。** 新登录（不论 client_id、os_type）让旧 token 返回 `10000 token无效`。迁移解决不了顶号，只能减少登录次数（已关闭周期同步，见 `PERIODIC_SYNC`）。
2. **FitDays+ 是独立服务端**：`plus-cn` / `plus-us` / `plus-eu` / `plus.fitdays.cn`，接口路径与字段命名都和 FitDays（`online*.fitdays.cn`）不同，`fitdays-api` SDK 不适用。FitDays+ 账号在三个 FitDays 服务器上都返回 `11000 账号或密码错误`。
3. 按下文还原的请求构造，测试账号在 `plus-cn.fitdays.cn` 登录与 `sync_from_server` 读取均成功。用户决定迁移到 FitDays+，适配器在迁移后按真实数据实现。

## 实验

脚本只调用登录与读取（最近 1 天），只输出返回码、提示语、是否拿到 token、主机名、顶层字段名与列表条数；凭据由用户在自己的终端隐藏输入。

| 脚本 | 账号 | 结果 |
| --- | --- | --- |
| `fitdays-login-probe.mjs`（cn） | FitDays 主账号 | 4 次登录均成功；A→B（新 client_id）后 A 失效；Android→iOS（os_type=1）后 Android 失效；iOS→Android 后 iOS 失效 |
| `fitdays-login-probe.mjs`（us/eu/cn） | FitDays+ 测试账号 | 12 次登录均 `11000`，无 302 |
| `fitdaysplus-login-probe.mjs`（CN） | FitDays+ 测试账号 | 3 次登录均成功（plus-cn）；每次新 token 可读；A→B 后 A 失效；B→C（os_type=1）后 B 失效 |

用户另观察到：同一 FitDays+ 测试账号在平板登录会顶掉手机。

## FitDays+ 请求构造（App 1.14.1，`cn.icomon.fitdayspro`）

来源：用户本人已 root 平板上安装的 App，经 adb 导出 dex（SHA-256 与设备一致）后用 jadx 1.5.6 静态分析。反编译产物未入库。

- **主机**：国家为 CN 时 `https://plus-cn.fitdays.cn`，否则 `https://plus-us.fitdays.cn`；登录类接口返回 `code=302` 时改用 `data.domain`（App 最多 3 次）。
- **方法与编码**：POST，请求体为请求对象字段的 JSON（`application/json;charset=utf-8`）。
- **查询参数**：`os_type=2&bapp_ver=1.0.0&country=<CN>&language=<zh>&source=0`（不参与签名）。
- **请求头**：`user-agent: FitdaysPlus-1.14.1`、`request-id: md5(uuid)`、`client-id: md5(uuid)`（安装期固定）、`account-id`（登录前 `"0"`）、`app-ver: 1.14.1`、`device-model: <品牌-型号-系统版本>`、`package-name: cn.icomon.fitdayspro`、`timestamp`（秒）、`token`（登录前空串）。
- **签名**：`sign = lower(md5(javaUrlEncode(按键名排序的 "k=v&…"（上述头部 + country）+ "fitdayspro")))`；`timezone`（原始偏移毫秒）与 `type`（账号类型，邮箱登录为 `1`）在签名之后加入头部。
- **登录** `/api/account/login`：`{account, type: 1, vcode: "", access_code: md5(md5(pw + "fitdayspro")), access_sign: md5(md5(urlencode(pw + "fitdayspro")))}`；返回 `data.account.{token, account_id, …}`、`data.users[]`、`name_maps`、`is_del`。
- **全量读取** `/api/sync/sync_from_server`：`{count, start_time, end_time}`（App 登录后用 `start_time=0, end_time=now`）；返回 `devices, bind_device, weights, weight_delete_list, heights, height_delete_list, hrs, hr_delete_list, skips, skip_delete_list, rulers, ruler_delete_list, reports, report_wifi_list, report_delete_list`。另有 `/api/sync/sync_increments`（未分析）。
- **写入接口存在但 Kinetrail 禁止调用**：`/api/device/insert_*`、`update_*`、`delete_*`、`/api/account/delete` 等。适配器只放行登录与读取两个路径。

## 迁移后待核实（适配器实现前）

- 真实账号各列表的字段名、类型与条数（只看结构）；阻抗/心率等是否并入 `weights` 或 `reports`。
- `*_delete_list` 的语义与 FitDays 的 `is_deleted` 如何对应。
- 迁移后 suid（`users[].suid` 或等价字段）与记录 ID 是否变化：影响 `PROFILE_ALLOWLIST` 与去重（`raw_records` 按 `data_id` 识别）。
- `sync_increments` 是否可替代分窗全量。
- 迁移前 D1 Time Travel 书签：`00000070-00000000-000050e7-47b4260ff4c6485eb503dca7bbd6e030`（2026-09-15T04:09Z）。
