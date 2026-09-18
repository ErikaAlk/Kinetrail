"""P3 GATT probe: dump the service table, then subscribe to EVERY notifiable
characteristic and print raw frames. Answers "which characteristic, what bytes,
does the 5-bit checksum hold" in one run.

    py -3 probe.py AA:BB:CC:DD:EE:FF [seconds]
"""
import asyncio
import sys

from bleak import BleakClient, BleakScanner


def show(uuid, data):
    b = bytes(data)
    ok = ""
    if len(b) == 20:
        ok = "OK" if b[19] == (sum(b[3:19]) & 0x1F) else f"BAD(want {sum(b[3:19]) & 0x1F:02x})"
    print(f"<- {uuid[4:8]} len={len(b):2d} {ok:<12} {b.hex()}", flush=True)


async def main(address, seconds):
    print(f"looking for {address} (step on the scale to wake it) ...")
    device = await BleakScanner.find_device_by_address(address, timeout=30.0)
    if device is None:
        print("not advertising. Step on the scale and retry.")
        return
    async with BleakClient(device) as client:
        notifiable = []
        for svc in client.services:
            print(f"\nservice {svc.uuid}")
            for ch in svc.characteristics:
                print(f"  char {ch.uuid}  {','.join(ch.properties)}")
                if "notify" in ch.properties or "indicate" in ch.properties:
                    notifiable.append(ch.uuid)

        print(f"\nsubscribing to {len(notifiable)} characteristic(s); "
              f"step on the scale, barefoot, hold still for {seconds:.0f}s\n", flush=True)
        for uuid in notifiable:
            try:
                await client.start_notify(uuid, lambda ch, d: show(ch.uuid, d))
            except Exception as e:  # some are notify-only on paper
                print(f"  (cannot subscribe {uuid[4:8]}: {e})")
        await asyncio.sleep(seconds)
    print("\ndisconnected.")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 60.0))
