"""体脂秤网关的 Home Assistant 外壳：蓝牙适配器归 HA 管时用它，代替 systemd 服务。

gateway.run() 原样跑在 HA 的事件循环里。HA 的蓝牙集成会把 bleak 的 BleakScanner/BleakClient
换成经它调度的包装类，所以网关和 HA 自己的蓝牙设备共用一个适配器，不会互相抢扫描。

部署见 gateway/README.md「部署在 Home Assistant 里」：把本目录连同 gateway/gateway.py、
research/p3/decode.py、research/p3/wla37.py 拷到 /config/custom_components/kinetrail_gateway/。
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

import homeassistant.helpers.config_validation as cv
import voluptuous as vol
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

# gateway.py 按顶层模块名 import decode、wla37
sys.path.append(str(Path(__file__).parent))
from . import gateway  # noqa: E402

DOMAIN = "kinetrail_gateway"
RESTART_DELAY_S = 30
log = logging.getLogger(__name__)

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                vol.Required("origin"): cv.url,
                vol.Required("token"): cv.string,
                vol.Required("scale_mac"): cv.string,
                vol.Required("height_cm"): vol.All(vol.Coerce(int), vol.Range(100, 250)),
                vol.Required("birth_date"): cv.date,
                vol.Required("sex"): vol.In([0, 1]),
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    conf = config[DOMAIN]
    state_dir = Path(hass.config.path(DOMAIN))
    # 队列里可能有室友的体重，目录只给 HA 自己读
    await hass.async_add_executor_job(lambda: state_dir.mkdir(mode=0o700, exist_ok=True))
    env = {
        "KT_ORIGIN": conf["origin"],
        "KT_SCALE_TOKEN": conf["token"],
        "KT_SCALE_MAC": conf["scale_mac"],
        "KT_HEIGHT_CM": str(conf["height_cm"]),
        "KT_BIRTH_DATE": conf["birth_date"].isoformat(),
        "KT_SEX": str(conf["sex"]),
        "KT_QUEUE": os.fspath(state_dir / "queue.json"),
    }
    hass.async_create_background_task(_keep_running(env), DOMAIN)
    return True


async def _keep_running(env: dict[str, str]) -> None:
    """systemd 的 Restart=always：run() 出了想不到的错就歇一会儿再起。日志只记异常类型，和网关一样不写读数。"""
    while True:
        try:
            await gateway.run(env)
        except Exception as e:
            log.warning("gateway stopped: %s, restarting in %ds", type(e).__name__, RESTART_DELAY_S)
        await asyncio.sleep(RESTART_DELAY_S)
