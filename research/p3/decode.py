"""沃莱 P3 的 BLE 帧解码：字节 -> 体重 + 阻抗。协议见 ../P3.md。

不依赖第三方库。直接跑这个文件会用合成帧自检：

    python research/p3/decode.py

带上 `probe.py` 打出来的十六进制帧则解一帧，按段位列出阻抗：

    python research/p3/decode.py 00001f00a76a...
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import List, Optional

TYPE_WEIGHT = 0xA2
TYPE_RESULT = 0xA7

#: 阻抗下标 -> 段位。前五个 20 kHz，后五个同段的 100 kHz，见 ../P3.md 第 2 节。
SEGMENTS = ("躯干", "左臂", "右臂", "左腿", "右腿")


@dataclass(frozen=True)
class Measurement:
    weight_kg: float
    impedances_ohm: List[float]
    is_stabilized: bool = True
    alg_type: Optional[int] = None      # A7 载荷 [5]：WLA 编号，P3 是 37


def frame_payload(frame: bytes) -> Optional[bytes]:
    """校验一帧并取出载荷；声明长度对不上或校验和不过返回 None。

    帧头是 [0]序号 [1:3]载荷长度 u16BE [3]分片，尾字节是 sum(载荷) & 0x1F。
    分片还没见过（P3.md 第 1 节），分片帧的声明长度大于本帧载荷，会在这里被拒，不猜着拼。
    """
    if len(frame) < 6:
        return None
    payload = frame[4:-1]
    if int.from_bytes(frame[1:3], "big") != len(payload):
        return None
    return payload if frame[-1] == (sum(payload) & 0x1F) else None


def decode(payload: bytes) -> Optional[Measurement]:
    """A2 实时体重 / A7 结果 -> Measurement。其它类型返回 None。"""
    if not payload:
        return None

    if payload[0] == TYPE_WEIGHT:
        # [1]状态 [2]0x00 [3:6]体重 u24BE 克 [6]0x00
        return Measurement(
            weight_kg=int.from_bytes(payload[3:6], "big") / 1000.0,
            impedances_ohm=[],
            is_stabilized=payload[1] in (0x02, 0x03),
        )

    if payload[0] == TYPE_RESULT:
        # [1:5]时间戳 [5]算法号 [6:9]体重 u24BE 克 [9]0x00 [10]阻抗个数 [11:]个数×u16BE
        # 体重按 u24 读：单次样本里 u16 恰好同值，但 65.535 kg 以上会溢出。
        if len(payload) < 11 or len(payload) < 11 + 2 * payload[10]:
            return None
        n = payload[10]
        imps = [int.from_bytes(payload[11 + 2 * i:13 + 2 * i], "big") / 10.0
                for i in range(n)]
        return Measurement(
            weight_kg=int.from_bytes(payload[6:9], "big") / 1000.0,
            impedances_ohm=imps,
            alg_type=payload[5],
        )

    return None


def _self_check() -> None:
    """合成帧（不是真人读数），结构与真机一致。"""
    a7 = bytes.fromhex(
        "00001f00a76a00000025011170000a012c0bb80bb80af00af000fa0af00af009c409c411")
    a2 = bytes.fromhex("00000700a203000111700007")

    p = frame_payload(a7)
    assert p is not None, "A7 校验和应当通过"
    m = decode(p)
    assert m is not None
    assert m.alg_type == 37, m.alg_type
    assert abs(m.weight_kg - 70.0) < 1e-9, m.weight_kg   # u16 会读成 4.464
    assert m.impedances_ohm == [30.0, 300.0, 300.0, 280.0, 280.0,
                                25.0, 280.0, 280.0, 250.0, 250.0], m.impedances_ohm

    p = frame_payload(a2)
    assert p is not None
    m = decode(p)
    assert m is not None and m.is_stabilized and not m.impedances_ohm
    assert abs(m.weight_kg - 70.0) < 1e-9, m.weight_kg

    assert frame_payload(a7[:-1] + bytes([(a7[-1] + 1) & 0xFF])) is None, "坏校验和应当被拒"
    short = a7[:3] + a7[3:-3] + bytes([sum(a7[4:-3]) & 0x1F])
    assert frame_payload(short) is None, "声明长度与载荷不符（截短、分片）应当被拒"
    assert decode(a7[4:24]) is None, "阻抗没收全的 A7 不能读成零"
    print("ok")


def _dump(hexstr: str) -> None:
    """解一帧并按段位打印，方便和报告页的「分部位阻抗」逐行对号。"""
    payload = frame_payload(bytes.fromhex(hexstr.replace(":", "").replace(" ", "")))
    m = decode(payload) if payload else None
    if m is None:
        print("校验和不过，或不是 A2/A7 帧")
        return
    print(f"体重 {m.weight_kg:.3f} kg" + (f"  算法号 {m.alg_type}" if m.alg_type else ""))
    if len(m.impedances_ohm) == 2 * len(SEGMENTS):
        print(f"{'段位':<6}{'20 kHz':>10}{'100 kHz':>10}")
        for i, name in enumerate(SEGMENTS):
            print(f"{name:<6}{m.impedances_ohm[i]:>10.1f}"
                  f"{m.impedances_ohm[i + len(SEGMENTS)]:>10.1f}")
    elif m.impedances_ohm:
        print(f"{len(m.impedances_ohm)} 个阻抗（不是 10 个，段位未知）"
              f"：{m.impedances_ohm}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        for arg in sys.argv[1:]:
            _dump(arg)
    else:
        _self_check()
