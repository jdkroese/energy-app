"""Identify the local protocol version of devices our Node client cannot reach.

WHY: tuyapi (Node) speaks 3.1-3.4 only. A v3.5 device is invisible twice over —
its discovery broadcast is AES-GCM under a different frame magic (so an ECB
decoder drops it and the device looks "powered off"), and every connection
attempt times out (so it then looks "dead"). That double-miss is what hid the
CB car charger and CB - up WCD's breakers.

tinytuya (Python) implements 3.1-3.5, so it can tell us the truth. This script is
READ-ONLY: it calls status() and never writes a datapoint.

Run on the mini (same LAN as the devices):
    python scripts/tuya-v35-probe.py
"""

import json
import os
import sys

try:
    import tinytuya
except ImportError:
    print("tinytuya not installed", file=sys.stderr)
    sys.exit(1)

DATA_DIR = os.environ.get("DATA_DIR", "/Users/joris/sites/energy/.data")
CACHE = os.path.join(DATA_DIR, "tuya-local.json")
# Newest first: if a device answers 3.5 we want to know that immediately.
VERSIONS = [3.5, 3.4, 3.3, 3.1]

with open(CACHE, "r", encoding="utf-8") as fh:
    cache = json.load(fh)

devices = cache.get("devices", [])
# Only devices we can actually attempt: a key, a LAN address, not a gateway
# sub-device (those are never IP-reachable at all).
candidates = [d for d in devices if d.get("localKey") and d.get("lanIp") and not d.get("sub")]

print(f"\nProbing {len(candidates)} device(s) across versions {VERSIONS}\n" + "=" * 76)

results = {}
for d in candidates:
    name = (d.get("name") or d["id"])[:32]
    working = None
    dp_count = 0
    for ver in VERSIONS:
        try:
            dev = tinytuya.Device(d["id"], d["lanIp"], d["localKey"], version=ver)
            dev.set_socketTimeout(5)
            status = dev.status()
        except Exception:
            continue
        if isinstance(status, dict) and "dps" in status:
            working = ver
            dp_count = len(status["dps"])
            break
    results[d["id"]] = working
    if working:
        print(f"  {name:<34} {d['lanIp']:<16} v{working}  OK  {dp_count} datapoints")
    else:
        print(f"  {name:<34} {d['lanIp']:<16} --    no version answered")

print("=" * 76)
by_ver = {}
for dev_id, ver in results.items():
    by_ver[ver] = by_ver.get(ver, 0) + 1
for ver, n in sorted(by_ver.items(), key=lambda kv: (kv[0] is None, kv[0])):
    label = f"v{ver}" if ver else "unreachable"
    print(f"  {label:<12} {n}")

reachable = sum(n for v, n in by_ver.items() if v)
print(f"\n  {reachable}/{len(candidates)} reachable locally with a 3.1-3.5 client.")
v35 = by_ver.get(3.5, 0)
if v35:
    print(f"  {v35} device(s) need v3.5 — tuyapi cannot reach these; the Node")
    print("  transport needs AES-GCM + session negotiation to control them.")
