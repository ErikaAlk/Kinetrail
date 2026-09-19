"""拿设备算法库生成的参考向量给 `wla37.py` 对账。

    python research/p3/check_wla37.py

夹具 `wla37-vectors.jsonl` 是在装了 FitDays+ 的安卓设备上用
`algorithm/Vectors.java` 调真库生成的（输入是合成网格，不是真人读数）。
要重新生成见 `algorithm/README.md`。
"""
from __future__ import annotations

import itertools
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import wla37

#: 设备返回的键 -> Metrics 的属性
SCALAR = {
    "bmi": "bmi",
    "bfr": "body_fat_percent",
    "muscle": "muscle_percent",
    "subcutfat": "subcutaneous_fat_percent",
    "vfal": "visceral_fat",
    "water": "body_water_percent",
    "sm": "skeletal_muscle_percent",
    "bone": "bone_mass_kg",
    "protein": "protein_percent",
    "bmr": "bmr_kcal",
    "age": "metabolic_age",
    "bodyScore": "body_score",
}

#: 设备的分段键前缀 -> 结果数组里的段名
SEGMENTS = {
    "leftArm": "left_arm",
    "rightArm": "right_arm",
    "leftLeg": "left_leg",
    "rightLeg": "right_leg",
    "trunk": "trunk",
}

#: 设备返回的分段键，四肢排列检查只看这些
SEGMENT_KEYS = [prefix + suffix for prefix in SEGMENTS for suffix in
                ("BodyfatMass", "BodyfatPercentage", "MuscleMass", "Muscle")]

TOLERANCE = 1e-6      # float64 复算与设备 float32 之间只该有尾数噪声


def outputs(m):
    """把 Metrics 摊平成设备那套键名。"""
    got = {k: getattr(m, attr) for k, attr in SCALAR.items()}
    for prefix, slot in SEGMENTS.items():
        fat_kg, fat_pct, muscle_kg, muscle_pct = wla37.SEGMENT_SLOTS[slot]
        got[prefix + "BodyfatMass"] = m.raw[fat_kg]
        got[prefix + "BodyfatPercentage"] = m.raw[fat_pct]
        got[prefix + "MuscleMass"] = m.raw[muscle_kg]
        got[prefix + "Muscle"] = m.raw[muscle_pct]
    return got


def check_limb_order(rows) -> int:
    """钉住四肢下标：z1 左臂、z2 右臂、z3 左腿、z4 右腿（z6..z9 同段的 100 kHz）。

    把 z1..z4 连同各自的 100 kHz 重排成 24 种排列，逐个喂进算法，和设备库输出的
    leftArm*/rightArm*/leftLeg*/rightLeg* 比。只有原顺序对得上，映射才是唯一确定的
    ——否则说明这批向量左右对称，分不出来。
    """
    runner_up = (None, float("inf"))
    for perm in itertools.permutations(range(1, 5)):
        worst = 0.0
        for r in rows:
            z = r["z"]
            pz = list(z)
            for slot, src in zip(range(1, 5), perm):
                pz[slot], pz[slot + 5] = z[src], z[src + 5]
            m = wla37.calc(weight=r["w"], height=r["h"], sex=r["sex"],
                           age=r["age"], people=r["p"], imps=pz)
            assert m is not None, f"重排后算法判定输入无效: {perm} {r}"
            got = outputs(m)
            worst = max(worst, max(abs(float(got[k]) - float(r["out"][k]))
                                   for k in SEGMENT_KEYS))
        if perm == (1, 2, 3, 4):
            if worst > TOLERANCE:
                print(f"  原顺序就复现不了设备的分段输出，偏差 {worst:.1e}")
                return 1
        elif worst < runner_up[1]:
            runner_up = (perm, worst)

    perm, worst = runner_up
    if worst <= TOLERANCE:
        print(f"  排列 z1..z4<-{perm} 也能复现设备输出，左右分不开")
        return 1
    print(f"24 种四肢排列里只有原顺序复现设备的分段输出，次优 z1..z4<-{perm} 差 {worst:.2f}")
    return 0


def main() -> int:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wla37-vectors.jsonl")
    with open(path, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]

    compared = 0
    failures = []
    worst = 0.0
    for r in rows:
        m = wla37.calc(weight=r["w"], height=r["h"], sex=r["sex"],
                       age=r["age"], people=r["p"], imps=r["z"])
        assert m is not None, f"算法判定输入无效，但设备有输出: {r}"
        got = outputs(m)
        for key, expected in r["out"].items():
            if key not in got:
                continue
            compared += 1
            delta = abs(float(got[key]) - float(expected))
            worst = max(worst, delta)
            if delta > TOLERANCE:
                failures.append((key, r, got[key], expected))

    for key, r, mine, expected in failures[:10]:
        print(f"  {key}: 本实现 {mine} vs 设备 {expected}"
              f"  (w={r['w']} h={r['h']} age={r['age']} sex={r['sex']} p={r['p']})")

    print(f"{len(rows)} 条向量 / {compared} 个数值，不一致 {len(failures)}，"
          f"最大偏差 {worst:.1e}")
    if failures:
        return 1
    return check_limb_order(rows)


if __name__ == "__main__":
    raise SystemExit(main())
