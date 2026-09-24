# 体脂秤网关

常驻一台有蓝牙的主机，有人站上沃莱 P3 就经 BLE 读结果帧、按 WLA37 算体成分，推到 Kinetrail 的 `POST /ingest/scale`。上秤不需要手机，也不需要 FitDays+。协议和算法见 [`research/P3.md`](../research/P3.md)，服务端规则见 `DATA_CONTRACT.md` 第 10 节。

- 只读不写：订阅 FFB2/FFB3，秤自己推实时体重和 A7 结果。代价是秤屏上的体成分那几格显示 `--`（没有 App 喂心跳）。
- 时间用网关收到 A7 的时刻。秤的时钟不可信（实测差 15 小时），平时由 FitDays+ 校时。
- 网关分不出上秤的是谁。服务端把与本人近 14 天体重中位数相差超过 `SCALE_WEIGHT_WINDOW_KG`（默认 4 kg）的称重整条丢掉；体重接近的室友会被当成本人记进去，在手机「记录」页那次称重的卡片底部删掉（物理删除）。
- 推不出去的称重存在队列文件里（systemd 部署是 `/var/lib/kinetrail-gateway/queue.json`，HA 里是 `/config/kinetrail_gateway/queue.json`），服务端给出结果（写入、未变或拒绝）才删；断网、服务端 5xx、令牌错误都会留着下次重推。这份文件里可能有室友的体重，目录只给服务用户读。
- 同目录的 `seen.json` 记最近 500 帧 A7 的哈希（不含读数）。秤可能在下次连接时重发旧结果，网关跳过见过的帧、接着等新的；服务端也按帧内容去重。
- 日志只有计数和状态码，不写体重和阻抗：systemd 部署看 `journalctl -u kinetrail-gateway -f`，HA 里看日志器 `gateway`（`ha core logs | grep gateway`）。

两种部署方式，程序是同一个 `gateway.py`：蓝牙适配器在普通 Linux 主机上就用 systemd 服务；适配器归 Home Assistant 管（比如直通给了 HAOS 虚拟机）就用 HA 集成。**本人实例 2026-09-24 起跑在 HAOS 里**（NanoPC-T6 上的虚拟机，适配器直通进去和光闹钟共用），之前是 T6 宿主上的 systemd 服务。

## 部署：systemd 服务

以下命令在网关主机上执行。

1. **蓝牙能用。** `hciconfig -a` 要看到 `UP RUNNING`。T6 用的 USB 适配器是 Realtek RTL8761BU（`0bda:8771`），Armbian 的固件包里没有它的固件，内核报 `rtl_bt/rtl8761bu_fw.bin not found`。`armbian-firmware` 与 Debian 的 `firmware-realtek` 互相冲突，别直接装后者（会卸掉整包 Armbian 固件），只从 Debian 官方包里取这两个文件：

   ```bash
   cd /tmp && apt-get download firmware-realtek && dpkg-deb -x firmware-realtek_*_all.deb fwx
   sudo install -m 644 fwx/usr/lib/firmware/rtl_bt/rtl8761bu_fw.bin fwx/usr/lib/firmware/rtl_bt/rtl8761bu_config.bin /usr/lib/firmware/rtl_bt/
   ```

   然后重插适配器（或 `echo 0`/`echo 1` 写它的 `authorized`）。这两个文件不属于任何包，`armbian-firmware` 升级不会动它们。

2. **依赖。** `sudo apt-get install --no-install-recommends python3-bleak`（Debian 13 是 0.22.3）。

3. **程序。** 建服务用户 `sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin kinetrail-gw`，把 `gateway/gateway.py`、`research/p3/decode.py`、`research/p3/wla37.py` 放进 `/opt/kinetrail-gateway/`（同一目录），`kinetrail-gateway.service` 放进 `/etc/systemd/system/`。在那台机器上跑一次 `python3 /opt/kinetrail-gateway/gateway.py --check`，输出 `ok`。

   单元里不用 `DynamicUser`：Armbian 的 `/etc/nsswitch.conf` 没有 `systemd` 模块，动态 uid 解析不了，dbus-daemon 在握手时直接断开（日志是 dbus_fast 的 `EOFError`）。从 `DynamicUser` 改过来的机器，systemd 会把 `/var/lib/private/kinetrail-gateway` 挪回 `/var/lib/kinetrail-gateway`，但属主留成 `nobody`，要 `chown -R kinetrail-gw:kinetrail-gw` 一次，否则第一次称重写队列时报权限错误。

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

## 部署：Home Assistant 集成

适配器归 HA 管时，别再另起一个进程直接用 BlueZ：会和 HA 的扫描互相打断。`homeassistant/kinetrail_gateway/` 是个很薄的外壳，在 HA 的事件循环里跑 `gateway.run()`；HA 的蓝牙集成把 bleak 的 `BleakScanner`/`BleakClient` 换成了经它调度的包装类，网关不用改就能和其他蓝牙设备共用适配器。

不做成 HAOS 加载项：Supervisor 构建本地加载项要从 Docker Hub 拉 `docker:*-cli`，Docker Hub 在国内网络被劫持（证书是别家的），构建直接失败。

1. HA 里要先有蓝牙集成（设置 → 设备与服务 → 蓝牙，看到适配器）。HAOS 自带 RTL8761BU 的固件，不用像 Armbian 那样手动装。
2. 把 `homeassistant/kinetrail_gateway/` 连同 `gateway/gateway.py`、`research/p3/decode.py`、`research/p3/wla37.py` 放进 `/config/custom_components/kinetrail_gateway/`（同一目录）。
3. 令牌写进 `/config/secrets.yaml`：`kinetrail_scale_token: "<令牌>"`。`configuration.yaml` 加：

   ```yaml
   kinetrail_gateway:
     origin: https://<你的 Kinetrail 域名>
     token: !secret kinetrail_scale_token
     scale_mac: "<秤的蓝牙地址>"
     height_cm: <身高，整数>
     birth_date: "<YYYY-MM-DD>"
     sex: <1 男 / 0 女>

   logger:
     logs:
       gateway: info   # 默认只记 warning，看不到 measured / pushed
   ```

   队列和 `seen.json` 放在 `/config/kinetrail_gateway/`（700）。从 systemd 部署搬过来时，把旧的 `seen.json` 拷过去，免得秤重发的旧帧被当成新的（服务端也会去重，只是多一次推送）。HA 的备份会带上 `/config`，队列里没推出去的称重也会进备份。
4. 重启 HA，日志里应出现 `[gateway] started, 0 pending`；站上秤后出现 `measured` 和 `pushed 1: accepted=1`。

HA 的包装类有两点和原生 bleak 不同：`find_device_by_address` 只查 HA 的缓存、立刻返回，不等 `timeout`（网关在没找到时自己歇 1 秒，否则会卡死 HA 的事件循环，2026-09-24 就这么卡过一次）；秤停止广播后 HA 还会缓存它几分钟，这段时间里网关会连几次连不上，日志是 `read failed`，不用管。

## 排查

| 日志 | 意思 |
| --- | --- |
| `connected but no result frame` | 连上了但 60 秒内没等到 A7：没站稳就下秤，或者手机上的 FitDays+ 先连走了 |
| `other frames: {...}` | 秤推了 A2/A7 之外的帧（类型/长度），或者声明长度对不上（`bad/长度`，可能是分片）。协议没见过的情况，拿 `research/p3/probe.py` 抓原始帧看。`a7/repeat` 是秤重发了收过的旧结果，已跳过 |
| `rejected=['SCALE_WEIGHT_OUT_OF_WINDOW']` | 不是本人（或本人体重变化超出窗口）。本人确实变了很多时，临时调大 `SCALE_WEIGHT_WINDOW_KG` |
| `rejected=['SCALE_NO_REFERENCE']` | 库里还没有本人的任何称重，窗口没有参考，网关的称重全部不收。新部署要先在 `SCALE_ACCEPT_AFTER` 之前经 Health Connect 推一次本人的称重 |
| `push failed: HTTP 401` | 令牌不对；改好配置后重启网关（`systemctl restart kinetrail-gateway`，或重启 HA），队列里的会重推 |
| `push failed: HTTP 404` | 服务端没设 `SCALE_INGEST_TOKEN_SHA256`，或还没部署网关入口 |
| `push failed: HTTP 503 not_configured` | `SCALE_ACCEPT_AFTER` 没设或格式不对 |
