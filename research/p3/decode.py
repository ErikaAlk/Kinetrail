"""沃莱 P3 的 BLE 帧解码：字节 -> 体重 + 阻抗。协议见 ../P3.md。

不依赖第三方库，不做 I/O。直接跑这个文件会用合成帧自检：

    python research/p3/decode.py
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

TYPE_WEIGHT = 0xA2
TYPE_RESULT = 0xA7


@dataclass(frozen=True)
class Measurement:
    weight_kg: float
    impedances_ohm: List[float]
    is_stabilized: bool = True
    alg_type: Optional[int] = None      # A7 载荷 [5]：WLA 编号，P3 是 37


def frame_payload(frame: bytes) -> Optional[bytes]:
    """校验一帧并取出载荷；校验和不过返回 None。

    帧头是 [0]序号 [1:3]载荷长度 u16BE [3]分片，尾字节是 sum(载荷) & 0x1F。
    """
    if len(frame) < 6:
        return None
    payload = frame[4:-1]
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
    print("ok")


if __name__ == "__main__":
    _self_check()
