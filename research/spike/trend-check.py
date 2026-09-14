"""固定统计口径的最小可运行数字样例；不是完整趋势服务。"""
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from statistics import median, mean


def daily_metrics(rows):
    days=defaultdict(list)
    for at,kg,pct in rows:
        day=datetime.fromisoformat(at).astimezone(timezone(timedelta(hours=8))).date()
        days[day].append((kg,kg*pct/100,kg-kg*pct/100))
    return {day:tuple(median(r[i] for r in values) for i in range(3)) for day,values in days.items()}


rows=[('2026-09-14T16:30:00+00:00',70,20),('2026-09-14T15:30:00+00:00',72,25),('2026-09-14T15:45:00+00:00',74,30)]
daily=daily_metrics(rows)
assert sorted(str(d) for d in daily)==['2026-09-14','2026-09-15']
assert mean(x[0] for x in daily.values())==71.5
assert abs(mean(x[1] for x in daily.values())-17.05)<1e-10
assert abs(mean(x[2] for x in daily.values())-54.45)<1e-10
assert mean(x[0] for x in daily.values())!=mean(r[1] for r in rows)
assert 45*(1+10/30)==60  # epley_v1
assert 20*0.45359237==9.071847400000001
print('PASS trend: Shanghai midnight, equal daily weighting, per-measurement fat/lean mass, epley_v1, lb conversion')
