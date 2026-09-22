# 体脂秤网关

常驻一台 Linux 小主机（本人实例是 NanoPC-T6），有人站上沃莱 P3 就经 BLE 读结果帧、按 WLA37 算体成分，推到 Kinetrail 的 `POST /ingest/scale`。上秤不需要手机，也不需要 FitDays+。协议和算法见 [`research/P3.md`](../research/P3.md)，服务端规则见 `DATA_CONTRACT.md` 第 10 节。

- 只读不写：订阅 FFB2/FFB3，秤自己推实时体重和 A7 结果。代价是秤屏上的体成分那几格显示 `--`（没有 App 喂心跳）。
- 时间用网关收到 A7 的时刻。秤的时钟不可信（实测差 15 小时），平时由 FitDays+ 校时。
- 网关分不出上秤的是谁。服务端把与本人近 14 天体重中位数相差超过 `SCALE_WEIGHT_WINDOW_KG`（默认 4 kg）的称重整条丢掉；体重接近的室友会被当成本人记进去，在手机「记录」页那次称重的卡片底部删掉（物理删除）。
- 推不出去的称重存在 `/var/lib/kinetrail-gateway/queue.json`，服务端给出结果（写入、未变或拒绝）才删；断网、服务端 5xx、令牌错误都会留着下次重推。这份文件里可能有室友的体重，只有服务用户能读。
- 日志只有计数和状态码，不写体重和阻抗：`journalctl -u kinetrail-gateway -f`。

## 部署

以下命令在网关主机上执行。

1. **蓝牙能用。** `hciconfig -a` 要看到 `UP RUNNING`。T6 用的 USB 适配器是 Realtek RTL8761BU（`0bda:8771`），Armbian 的固件包里没有它的固件，内核报 `rtl_bt/rtl8761bu_fw.bin not found`。`armbian-firmware` 与 Debian 的 `firmware-realtek` 互相冲突，别直接装后者（会卸掉整包 Armbian 固件），只从 Debian 官方包里取这两个文件：

   ```bash
   cd /tmp && apt-get download firmware-realtek && dpkg-deb -x firmware-realtek_*_all.deb fwx
   sudo install -m 644 fwx/usr/lib/firmware/rtl_bt/rtl8761bu_fw.bin fwx/usr/lib/firmware/rtl_bt/rtl8761bu_config.bin /usr/lib/firmware/rtl_bt/
   ```

   然后重插适配器（或 `echo 0`/`echo 1` 写它的 `authorized`）。这两个文件不属于任何包，`armbian-firmware` 升级不会动它们。

2. **依赖。** `sudo apt-get install --no-install-recommends python3-bleak`（Debian 13 是 0.22.3）。

3. **程序。** 把 `gateway/gateway.py`、`research/p3/decode.py`、`research/p3/wla37.py` 放进 `/opt/kinetrail-gateway/`（同一目录），`kinetrail-gateway.service` 放进 `/etc/systemd/system/`。在那台机器上跑一次 `python3 /opt/kinetrail-gateway/gateway.py --check`，输出 `ok`。

4. **令牌。** 在自己的 PowerShell 7 里生成，令牌只在变量里：

   ```powershell
   $scaleToken = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
   $scaleHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($scaleToken))).ToLower()
   $scaleHash | npx wrangler secret put SCALE_INGEST_TOKEN_SHA256 -c wrangler.local.jsonc
   ```

   令牌写进下一步的配置文件后 `Remove-Variable scaleToken, scaleHash`。它和手机的推送令牌分开：这个只能往网关入口写称重，读不了、也删不了任何东西。

5. **配置** `/etc/kinetrail-gateway.env`（`sudo install -m 600 -o root -g root /dev/null /etc/kinetrail-gateway.env` 后编辑）：

   ```ini
   KT_ORIGIN=https://<你的 Kinetrail 域名>
   KT_SCALE_TOKEN=<上一步的令牌>
   KT_SCALE_MAC=<秤的蓝牙地址，站上秤后 bluetoothctl scan le 里名字是 icomon 的那个>
   KT_HEIGHT_CM=<身高，整数>
   KT_BIRTH_DATE=<出生日期 YYYY-MM-DD>
   KT_SEX=<1 男 / 0 女>
   ```

   身高要和服务端的 `HC_HEIGHT_CM` 一致；出生日期只在这台机器上，用来按称重当天算整岁（年龄只影响身体年龄、身体得分和分段百分比）。

6. **服务端切换**：在 `wrangler.local.jsonc` 的 vars 里把 `SCALE_ACCEPT_AFTER` 设成网关接手的时刻（带时区的 RFC3339），部署。之后的称重只收网关，Health Connect 只收这之前的，两个来源不重叠（FitDays+ 之后再写进 HC 的称重会被拒成 `HC_AFTER_CUTOVER`）。

7. **启动**：`sudo systemctl daemon-reload && sudo systemctl enable --now kinetrail-gateway`，站上秤，日志里应出现 `measured` 和 `pushed 1: accepted=1`。

## 排查

| 日志 | 意思 |
| --- | --- |
| `connected but no result frame` | 连上了但 60 秒内没等到 A7：没站稳就下秤，或者手机上的 FitDays+ 先连走了 |
| `other frames: {...}` | 秤推了 A2/A7 之外的帧（类型/长度），或者声明长度对不上（`bad/长度`，可能是分片）。协议没见过的情况，拿 `research/p3/probe.py` 抓原始帧看 |
| `rejected=['SCALE_WEIGHT_OUT_OF_WINDOW']` | 不是本人（或本人体重变化超出窗口）。本人确实变了很多时，临时调大 `SCALE_WEIGHT_WINDOW_KG` |
| `rejected=['SCALE_NO_REFERENCE']` | 库里还没有本人的任何称重，窗口没有参考。先用 Health Connect 推一次 |
| `push failed: HTTP 401` | 令牌不对；改好配置后 `systemctl restart kinetrail-gateway`，队列里的会重推 |
| `push failed: HTTP 404` | 服务端没设 `SCALE_INGEST_TOKEN_SHA256`，或还没部署网关入口 |
| `push failed: HTTP 503 not_configured` | `SCALE_ACCEPT_AFTER` 没设或格式不对 |
