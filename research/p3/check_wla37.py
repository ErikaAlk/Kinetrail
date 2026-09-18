"""拿设备算法库生成的参考向量给 `wla37.py` 对账。

    python research/p3/check_wla37.py

夹具 `wla37-vectors.jsonl` 是在装了 FitDays+ 的安卓设备上用
`algorithm/Vectors.java` 调真库生成的（输入是合成网格，不是真人读数）。
要重新生成见 `algorithm/README.md`。
"""
from __future__ import annotations

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
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
