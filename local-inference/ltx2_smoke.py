"""LTX-2 smoke test: send /i2v with a real PNG, stream NDJSON, save MP4."""
from __future__ import annotations

import base64
import json
import sys
import time
from pathlib import Path

import requests

INPUT_PNG = Path(__file__).resolve().parent / "test-input.png"
OUTPUT_MP4 = Path(__file__).resolve().parent / "ltx2-smoke.mp4"

img_b64 = base64.b64encode(INPUT_PNG.read_bytes()).decode()

payload = {
    "prompt": (
        "Cinematic gentle camera dolly forward across a soft warm horizon, "
        "golden afternoon light streaming, dust motes drifting through the air, "
        "slight wind suggesting movement, calm and serene atmosphere"
    ),
    "imageBase64": img_b64,
    "durationSeconds": 5,
    "resolution": "720p",
}

t0 = time.time()
print(f"[{time.time()-t0:6.1f}s] POST /i2v ({len(img_b64)} b64 chars)", flush=True)

with requests.post(
    "http://127.0.0.1:7863/i2v",
    json=payload,
    timeout=3600,
    stream=True,
) as r:
    print(f"[{time.time()-t0:6.1f}s] HTTP {r.status_code}", flush=True)
    if r.status_code != 200:
        print(r.text[:2000])
        sys.exit(1)

    for line in r.iter_lines():
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError as e:
            print(f"[{time.time()-t0:6.1f}s] non-JSON line: {line[:200]!r} ({e})", flush=True)
            continue

        evt_type = evt.get("type")
        if evt_type == "completed":
            mp4 = base64.b64decode(evt["videoBase64"])
            OUTPUT_MP4.write_bytes(mp4)
            print(
                f"[{time.time()-t0:6.1f}s] completed: {len(mp4)} bytes, "
                f"durationMs={evt.get('durationMs')}, vramPeakMib={evt.get('vramPeakMib')}",
                flush=True,
            )
        elif evt_type == "error":
            print(f"[{time.time()-t0:6.1f}s] ERROR: {json.dumps(evt)[:500]}", flush=True)
            sys.exit(2)
        else:
            # started, in_progress, etc.
            print(
                f"[{time.time()-t0:6.1f}s] {evt_type}: "
                f"{json.dumps({k: v for k, v in evt.items() if k != 'videoBase64'})[:200]}",
                flush=True,
            )

print(f"[{time.time()-t0:6.1f}s] done. wrote {OUTPUT_MP4}", flush=True)
