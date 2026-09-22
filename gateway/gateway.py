"""沃莱 P3 体脂秤网关：常驻 T6，有人上秤就经 BLE 读结果帧，算体成分，推给 Kinetrail。

只读不写：订阅 FFB2/FFB3 后秤自己推 A2 实时体重和 A7 结果（research/P3.md）。
时间用收到 A7 的时刻（秤的 RTC 不可信）。推不出去的写进本地队列，服务端给出结果才删。
日志只写计数和状态码，不写体重、阻抗（室友上秤也会被读到，服务端才判断是不是本人）。

配置全在环境变量（部署见 README.md）：
  KT_ORIGIN        Kinetrail 地址，如 https://kinetrail.example.com
  KT_SCALE_TOKEN   网关推送令牌（服务端存它的 SHA-256：SCALE_INGEST_TOKEN_SHA256）
  KT_SCALE_MAC     秤的蓝牙地址
  KT_HEIGHT_CM     身高（整数 cm）
  KT_BIRTH_DATE    出生日期 YYYY-MM-DD，按称重当天算整岁
  KT_SEX           1 男 / 0 女（WLA37 的编码）
  KT_QUEUE         待发队列文件，默认 /var/lib/kinetrail-gateway/queue.json；
                   同目录的 seen.json 记最近收过的 A7 的哈希（不存读数），重启后也不把秤重发的旧帧当新的

python3 gateway.py --check 用合成帧自检，不需要蓝牙。
"""
from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# 部署时 decode.py、wla37.py 和本文件放同一目录；在仓库里直接跑时去 research/p3 找。
sys.path.append(str(Path(__file__).resolve().parent.parent / "research" / "p3"))
import decode  # noqa: E402
import wla37  # noqa: E402

FFB2 = "0000ffb2-0000-1000-8000-00805f9b34fb"
FFB3 = "0000ffb3-0000-1000-8000-00805f9b34fb"
P3_ALGORITHM = 37          # A7 载荷 [5]：WLA 编号
RESULT_TIMEOUT_S = 60      # 连上之后等 A7 的时长：站稳、测阻抗要十来秒
# 收过的 A7 载荷只按数量淘汰、不按时间：帧里有秤自己的时间戳，新称重不会和旧帧相同；
# 按时间淘汰的话，秤每次连接都重发的旧帧过期后会被当成新的，网关拿着它断开、漏掉真正的新结果。
SEEN_LIMIT = 500
MAX_PER_REQUEST = 50
# 按北京时间算称重当天的整岁（中国不用夏令时，固定 +8 就够，不依赖系统时区和 tzdata）
LOCAL_TZ = dt.timezone(dt.timedelta(hours=8))

log = logging.getLogger("gateway")


def age_on(birth: dt.date, day: dt.date) -> int:
    return day.year - birth.year - ((day.month, day.day) < (birth.month, birth.day))


def measurement(payload: bytes, time_ms: int, height: int, birth: dt.date, sex: int) -> dict | None:
    """A7 载荷 -> 推送项。不是 A7 或读不出体重返回 None。

    体重和阻抗由服务端从 a7_hex 自己解，这里只附算法输入和 WLA37 的输出。
    阻抗过不了算法门限（没光脚、没握手柄）时只有 BMI。
    """
    m = decode.decode(payload)
    if m is None or m.alg_type is None or m.weight_kg <= 0:
        return None
    age = age_on(birth, dt.datetime.fromtimestamp(time_ms / 1000, LOCAL_TZ).date())
    metrics: dict[str, float] = {"bmi": wla37.ceil(m.weight_kg * 10000.0 / (height * height))}
    r = None
    if m.alg_type == P3_ALGORITHM and len(m.impedances_ohm) == 10:
        r = wla37.calc(m.weight_kg, height, sex, age, 0, m.impedances_ohm)
    if r is not None:
        metrics.update({
            "body_fat_pct": r.body_fat_percent,
            "muscle_pct": r.muscle_percent,
            "subcutaneous_fat_pct": r.subcutaneous_fat_percent,
            "visceral_fat_index": r.visceral_fat,
            "bone_mass_kg": r.bone_mass_kg,
            "body_water_pct": r.body_water_percent,
            "protein_pct": r.protein_percent,
            "skeletal_muscle_pct": r.skeletal_muscle_percent,
            "bmr_kcal": float(r.bmr_kcal),
            "body_age": float(r.metabolic_age),
            "body_score": r.body_score,
        })
    return {
        "time_ms": time_ms,
        "a7_hex": payload.hex(),
        "algorithm": "WLA37",
        "inputs": {"height_cm": height, "age": age, "sex": sex, "people_type": 0},
        # WLA37 在 float32 里舍入到一位小数（22.899999618530273 就是显示的 22.9），按一位小数还原
        "metrics": {k: round(v, 1) for k, v in metrics.items()},
    }


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data) -> None:
    """先写临时文件再改名，写到一半断电也不会留下半份。"""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), "utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def fingerprint(payload: bytes) -> str:
    """只存哈希：seen.json 会长期留着，别让它变成一份室友体重的记录。"""
    return hashlib.sha256(payload).hexdigest()[:32]


def remember(seen: list[str], digest: str) -> list[str]:
    return [h for h in seen if h != digest][-(SEEN_LIMIT - 1):] + [digest]


class Queue:
    """待发项存一个 JSON 文件。"""

    def __init__(self, path: Path):
        self.path = path
        self.items: list[dict] = load_json(path, [])

    def save(self) -> None:
        save_json(self.path, self.items)

    def add(self, item: dict) -> None:
        self.items.append(item)
        self.save()

    def drop_first(self, count: int) -> None:
        # 按位置删刚发出去的那一批：不同称重可能同一毫秒（时钟回拨），按时间删会连没发的一起删掉
        self.items = self.items[count:]
        self.save()


def post(origin: str, token: str, items: list[dict]) -> tuple[int, dict]:
    body = json.dumps({"schema_version": "1", "measurements": items}).encode()
    req = urllib.request.Request(
        f"{origin}/ingest/scale", data=body, method="POST",
        headers={"authorization": f"Bearer {token}", "content-type": "application/json",
                 "user-agent": "KinetrailGateway/1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def flush(queue: Queue, origin: str, token: str) -> None:
    """推送队列。200 时每一项都有了结果（写入、未变或拒绝），全部移出；
    400 是请求本身不对，重试也不会好，丢掉这批并记一行；其余（网络、401、429、5xx）留着下次再推。"""
    while queue.items:
        batch = queue.items[:MAX_PER_REQUEST]
        try:
            status, result = post(origin, token, batch)
        except (urllib.error.URLError, OSError, ValueError) as e:
            log.warning("push failed: %s, %d pending", type(e).__name__, len(queue.items))
            return
        if status == 200:
            codes = sorted({r.get("code", "?") for r in result.get("rejected", [])})
            log.info("pushed %d: accepted=%s unchanged=%s rejected=%s",
                     len(batch), result.get("accepted"), result.get("unchanged"), codes or "none")
        elif status == 400:
            log.error("server rejected the request format (%s), dropping %d", result.get("error"), len(batch))
        else:
            log.warning("push failed: HTTP %d %s, %d pending", status, result.get("error", ""), len(queue.items))
            return
        queue.drop_first(len(batch))


async def read_result(device, known: set[str]) -> bytes | None:
    """连秤、订阅，等到一帧没见过的 A7 就断开。见过的（秤重发的旧结果）跳过接着等，免得拿着旧帧断开、漏掉新称重。
    其他帧只记类型和长度，给以后查协议用。"""
    from bleak import BleakClient

    loop = asyncio.get_running_loop()
    result: asyncio.Future[bytes] = loop.create_future()
    seen: dict[str, int] = {}

    def on_frame(_char, data: bytearray) -> None:
        payload = decode.frame_payload(bytes(data))
        if payload is None:
            seen[f"bad/{len(data)}"] = seen.get(f"bad/{len(data)}", 0) + 1
        elif payload[0] == decode.TYPE_RESULT:
            if fingerprint(payload) in known:
                seen["a7/repeat"] = seen.get("a7/repeat", 0) + 1
            elif not result.done():
                result.set_result(payload)
        elif payload[0] != decode.TYPE_WEIGHT:
            key = f"{payload[0]:02x}/{len(payload)}"
            seen[key] = seen.get(key, 0) + 1

    async with BleakClient(device, timeout=20.0) as client:
        for uuid in (FFB2, FFB3):
            await client.start_notify(uuid, on_frame)
        try:
            return await asyncio.wait_for(result, RESULT_TIMEOUT_S)
        except asyncio.TimeoutError:
            return None
        finally:
            if seen:
                log.info("other frames: %s", seen)


async def run() -> None:
    from bleak import BleakScanner

    origin = os.environ["KT_ORIGIN"].rstrip("/")
    token = os.environ["KT_SCALE_TOKEN"]
    mac = os.environ["KT_SCALE_MAC"]
    height = int(os.environ["KT_HEIGHT_CM"])
    birth = dt.date.fromisoformat(os.environ["KT_BIRTH_DATE"])
    sex = int(os.environ["KT_SEX"])
    queue = Queue(Path(os.environ.get("KT_QUEUE", "/var/lib/kinetrail-gateway/queue.json")))
    seen_path = queue.path.with_name("seen.json")
    seen: list[str] = load_json(seen_path, [])
    log.info("started, %d pending", len(queue.items))

    while True:
        flush(queue, origin, token)
        device = await BleakScanner.find_device_by_address(mac, timeout=60.0)
        if device is None:
            continue
        try:
            payload = await read_result(device, set(seen))
        except Exception as e:  # 秤走开、连接中断、BlueZ 报错：都等下一次上秤
            log.warning("read failed: %s", type(e).__name__)
            await asyncio.sleep(5)
            continue
        if payload is None:
            log.info("connected but no result frame")
            continue
        now = time.time()
        seen = remember(seen, fingerprint(payload))
        save_json(seen_path, seen)
        item = measurement(payload, int(now * 1000), height, birth, sex)
        if item is None:
            log.warning("unreadable result frame (%d bytes)", len(payload))
            continue
        queue.add(item)
        log.info("measured, %d pending", len(queue.items))
        # 秤出结果后还会亮一阵、继续广播；歇一会儿再扫，免得反复连它（BlueZ 在设备停播约 30 秒后才从缓存里清掉）
        await asyncio.sleep(60)


def _self_check() -> None:
    """合成帧（decode.py 自检用的那帧，不是真人读数）。推送项必须与服务端测试共用的夹具逐字相同。"""
    frame = bytes.fromhex("00001f00a76a00000025011170000a012c0bb80bb80af00af000fa0af00af009c409c411")
    payload = decode.frame_payload(frame)
    assert payload is not None
    birth = dt.date(1990, 6, 15)
    assert age_on(birth, dt.date(2026, 6, 14)) == 35 and age_on(birth, dt.date(2026, 6, 15)) == 36
    item = measurement(payload, 1789948800000, 175, birth, 1)  # 2026-09-21T08:00:00+08:00
    fixture = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "gateway-measurement.json"
    if fixture.exists():
        assert item == json.loads(fixture.read_text("utf-8")), item
    # 阻抗全零（没光脚）：算法门限不过，只剩 BMI
    bare = payload[:11] + bytes(20) + payload[31:]
    assert set(measurement(bare, 1789948800000, 175, birth, 1)["metrics"]) == {"bmi"}
    # 队列：写入、改名；只删发出去的那几项，同一毫秒的另一次称重留着
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        q = Queue(Path(d) / "q.json")
        q.add(item)
        q.add({**item, "a7_hex": bare.hex()})
        assert len(Queue(Path(d) / "q.json").items) == 2
        q.drop_first(1)
        assert [i["a7_hex"] for i in Queue(Path(d) / "q.json").items] == [bare.hex()]
    # 收过的帧只按数量淘汰；重复的挪到最新，不占两格
    many = [f"{i:02x}" for i in range(SEEN_LIMIT)]
    kept = remember(many, "new")
    assert len(kept) == SEEN_LIMIT and kept[0] == "01" and kept[-1] == "new"
    assert remember(["a", "b"], "a") == ["b", "a"]
    # 连接里先来一帧见过的旧结果、再来新结果：拿新的
    asyncio.run(_check_read_result(payload, bare))
    print("ok")


async def _check_read_result(old: bytes, new: bytes) -> None:
    """用假的 BleakClient 喂两帧：旧帧（已见过）在前，新帧在后。"""
    import types

    def framed(p: bytes) -> bytes:
        return bytes([0]) + len(p).to_bytes(2, "big") + bytes([0]) + p + bytes([sum(p) & 0x1F])

    class FakeClient:
        def __init__(self, _device, timeout):
            self.callbacks = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def start_notify(self, _uuid, callback):
            self.callbacks.append(callback)
            if len(self.callbacks) == 2:
                loop = asyncio.get_running_loop()
                loop.call_soon(callback, None, bytearray(framed(old)))
                loop.call_later(0.01, callback, None, bytearray(framed(new)))

    real = sys.modules.get("bleak")
    sys.modules["bleak"] = types.SimpleNamespace(BleakClient=FakeClient)
    try:
        assert await read_result(None, {fingerprint(old)}) == new
    finally:
        if real is None:
            del sys.modules["bleak"]
        else:
            sys.modules["bleak"] = real


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        _self_check()
    else:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
        asyncio.run(run())
