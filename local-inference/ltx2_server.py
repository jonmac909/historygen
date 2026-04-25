"""LTX-2 image-to-video local-inference server (port 7863).

Wraps `ltx_pipelines.DistilledPipeline` (D:\\LTX-2\\packages\\...).
Locked API contract:
- POST /i2v          -> NDJSON stream (per ZG-21): started, completed (and error)
- POST /unload       -> 200 idempotent, 409 if loading (ZG-31)
- GET  /healthz      -> {status, modelLoaded}
- GET  /healthz?ready=1 -> blocks until pipeline constructed (ZG-7)

Single inference at a time via InferenceLock (FIFO; ZG-23). Pipeline lazy-loads
on first /i2v unless PRE_WARM=1. IdleUnloader drops the pipeline after 90 s
idle (ZG-2).

Memory strategy:
- LTX-2 22B BF16 weights are ~43 GB. 5070 has 12 GB VRAM. We MUST offload.
- DistilledPipeline takes `offload_mode: OffloadMode` (NONE | CPU | DISK)
  and `quantization: QuantizationPolicy | None` (FP8 cast).
- Verified at blocks.py:158-162: `DiffusionStage` raises ValueError
  "quantization is not supported with layer streaming" if both are set.
- Default: OffloadMode.CPU, quantization off (~36 GB RAM + ~5 GB VRAM per
  OffloadMode docstring). Set LTX2_OFFLOAD=disk for ~5 GB RAM + ~5 GB VRAM
  (slower). Set LTX2_OFFLOAD=none on rigs that can hold the model on GPU;
  fp8_cast is applied automatically in that mode (per README quick-start).

Key insight from blocks.py: each pipeline block (PromptEncoder,
ImageConditioner, DiffusionStage, VideoUpsampler, VideoDecoder, AudioDecoder)
loads its own weights on `__call__` and frees them via gpu_model() context.
The pipeline object itself only holds configurators + builders (small),
so /unload mainly drops the pipeline reference and clears CUDA cache.

NDJSON streaming limitation (per brief): the LTX-2 pipeline call is one
synchronous tuple-returning function with no public step callback. We emit
`started` immediately and `completed` after the call returns. Periodic
`in_progress` heartbeats are emitted from a watchdog thread every 30 s while
inference runs (so the render-api SSE pipe stays alive on multi-minute calls).
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Literal, Optional

# LTX-2 packages were installed via `uv sync --frozen` into D:\LTX-2\.venv,
# but this server may run under a different python (e.g. when launched
# directly with the venv's python.exe, the editable installs are picked up
# automatically). Belt-and-braces: prepend the workspace src dirs to sys.path
# so imports resolve even if installed metadata is missing.
LTX2_REPO = Path(r"D:\LTX-2")
for sub in ("ltx-pipelines", "ltx-core"):
    src = LTX2_REPO / "packages" / sub / "src"
    if str(src) not in sys.path and src.is_dir():
        sys.path.insert(0, str(src))

# HF cache lives on D: (the only volume with room).
os.environ.setdefault("HF_HOME", r"D:\hf_cache")
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", r"D:\hf_cache\hub")

import torch  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import Request  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402
from PIL import Image  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field, ValidationError  # noqa: E402

from common import (  # noqa: E402
    IdleUnloader,
    InferenceLock,
    ModelLoadingError,
    error_envelope,
    make_app,
    patch_safetensors_to_cuda,
)


# -- logging --------------------------------------------------------------
LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_PATH = LOG_DIR / "ltx2.log"

logger = logging.getLogger("ltx2")
logger.setLevel(logging.INFO)
_fh = logging.FileHandler(str(LOG_PATH), mode="a", encoding="utf-8")
_fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(_fh)
_sh = logging.StreamHandler(sys.stdout)
_sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(_sh)


# -- weight paths ---------------------------------------------------------
HF_CACHE = Path(r"D:\hf_cache")
LTX_CHECKPOINT = HF_CACHE / "Lightricks--LTX-2.3" / "ltx-2.3-22b-distilled-1.1.safetensors"
LTX_UPSCALER = HF_CACHE / "Lightricks--LTX-2.3" / "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
GEMMA_ROOT = HF_CACHE / "google--gemma-3-12b-it-qat-q4_0-unquantized"

# Resolution map. DistilledPipeline calls assert_resolution(is_two_stage=True)
# which requires both dims % 64 == 0. Chosen values approximate the named
# resolutions while honoring the divisor.
#   "720p" -> 1280 x 704  (16:8.8, very close to 16:9 = 1.778; ratio 1.818)
#   "480p" -> 832  x 448  (ratio 1.857)
RESOLUTION_DIMS = {
    "720p": (1280, 704),
    "480p": (832, 448),
}

# Frame-rate fixed at 24 fps (LTX-2 default). num_frames = 8K + 1.
FRAME_RATE = 24.0


def _frames_for_duration(duration_seconds: float) -> int:
    """Round duration_seconds * 24 fps to the nearest 8K + 1."""
    target = int(round(duration_seconds * FRAME_RATE))
    # solve 8K + 1 closest to target
    k = max(1, round((target - 1) / 8))
    return 8 * k + 1


# Offload mode is configurable via env. Default 'cpu' per README guidance for
# < 24 GB VRAM rigs. Use 'disk' for low-RAM setups, 'none' for fits-on-GPU.
OFFLOAD_MODE_ENV = os.environ.get("LTX2_OFFLOAD", "cpu").lower()


# -- model holder ---------------------------------------------------------
class ModelHolder:
    """Owns the DistilledPipeline + its lock + idle unloader."""

    def __init__(self) -> None:
        self.lock = InferenceLock()
        self._pipeline = None
        self._idle = IdleUnloader(self._idle_unload, idle_seconds=90.0)

    def is_loaded(self) -> bool:
        return self._pipeline is not None

    def _build_pipeline(self):
        from ltx_core.loader import LoraPathStrengthAndSDOps
        from ltx_core.quantization import QuantizationPolicy
        from ltx_pipelines import DistilledPipeline
        from ltx_pipelines.utils.types import OffloadMode

        offload_map = {
            "none": OffloadMode.NONE,
            "cpu": OffloadMode.CPU,
            "disk": OffloadMode.DISK,
        }
        offload_mode = offload_map.get(OFFLOAD_MODE_ENV, OffloadMode.CPU)

        # Verified at blocks.py:158-162 — DiffusionStage rejects quantization
        # when offload_mode != NONE ("quantization is not supported with
        # layer streaming"). On a 12 GB 5070 we MUST offload (43 GB BF16
        # checkpoint), so quantization is forced off in that mode. When the
        # operator opts into OffloadMode.NONE (e.g. on a future GPU with
        # ample VRAM) we apply fp8_cast per the LTX-2 README quick-start
        # recommendation.
        quantization = QuantizationPolicy.fp8_cast() if offload_mode == OffloadMode.NONE else None

        # DistilledPipeline does not consume an external distilled-LoRA arg
        # (the distilled weights are baked into the checkpoint). Per
        # `default_2_stage_distilled_arg_parser`, the only required extra
        # path beyond the distilled checkpoint is the spatial upsampler.
        loras: list[LoraPathStrengthAndSDOps] = []

        logger.info(
            "building DistilledPipeline: offload=%s, quantization=%s, ckpt=%s, gemma=%s",
            offload_mode.value,
            "fp8_cast" if quantization is not None else "off",
            LTX_CHECKPOINT.name,
            GEMMA_ROOT.name,
        )
        return DistilledPipeline(
            distilled_checkpoint_path=str(LTX_CHECKPOINT),
            gemma_root=str(GEMMA_ROOT),
            spatial_upsampler_path=str(LTX_UPSCALER),
            loras=loras,
            quantization=quantization,
            torch_compile=False,
            offload_mode=offload_mode,
        )

    def load_inside_lock(self) -> None:
        if self._pipeline is not None:
            return
        patch_safetensors_to_cuda()
        t0 = time.monotonic()
        self._pipeline = self._build_pipeline()
        logger.info("DistilledPipeline constructed in %.1fs", time.monotonic() - t0)

    def ensure_loaded(self) -> None:
        if self._pipeline is not None:
            return
        with self.lock.acquire_for_request():
            if self._pipeline is not None:
                return
            self.lock.set_status("loading")
            try:
                self.load_inside_lock()
                self.lock.set_status("ready")
            except Exception:
                self.lock.set_status("error")
                self._pipeline = None
                raise

    def unload(self) -> None:
        if self._pipeline is None:
            return
        logger.info("unloading DistilledPipeline ...")
        # Each block holds builders/configurators only — the model weights
        # themselves are loaded/freed per __call__. Drop the pipeline ref so
        # any cached state (e.g. pinned-RAM tensors via OffloadMode.CPU) is
        # released, then clear CUDA cache.
        try:
            for attr in (
                "prompt_encoder",
                "image_conditioner",
                "stage",
                "upsampler",
                "video_decoder",
                "audio_decoder",
            ):
                comp = getattr(self._pipeline, attr, None)
                if comp is None:
                    continue
                # Builders pin model paths; nothing to .to('cpu') here.
                # Just drop references and let GC reclaim.
                setattr(self._pipeline, attr, None)
        finally:
            self._pipeline = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.reset_peak_memory_stats()
            logger.info("DistilledPipeline unloaded")

    def _idle_unload(self) -> None:
        if self._pipeline is None:
            return
        try:
            with self.lock.acquire_for_unload():
                self.unload()
                self.lock.set_status("idle")
            logger.info("idle-unload fired")
        except ModelLoadingError:
            pass
        except Exception as e:
            logger.warning("idle-unload skipped: %s", e)

    def touch_idle(self) -> None:
        self._idle.touch()

    @property
    def pipeline(self):
        assert self._pipeline is not None
        return self._pipeline


holder = ModelHolder()


# -- request schema -------------------------------------------------------
class I2VRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    prompt: str = Field(..., min_length=10, max_length=2000)
    image_base64: str = Field(..., alias="imageBase64", min_length=1)
    negative_prompt: str = Field(default="", alias="negativePrompt", max_length=2000)
    duration_seconds: float = Field(default=5.0, ge=3.0, le=10.0, alias="durationSeconds")
    resolution: Literal["720p", "480p"] = Field(default="720p")
    seed: Optional[int] = Field(default=None)


# -- app ------------------------------------------------------------------
app = make_app(holder, "LTX-2")


def _ndjson_line(obj: dict) -> bytes:
    return (json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8")


def _decode_image_to_temp(image_b64: str) -> tuple[str, tuple[int, int]]:
    """Decode base64 image bytes; verify with PIL; return (temp_path, (w, h))."""
    img_bytes = base64.b64decode(image_b64, validate=True)
    img = Image.open(io.BytesIO(img_bytes))
    img.load()
    w, h = img.size
    if img.mode != "RGB":
        img = img.convert("RGB")
    tf = tempfile.NamedTemporaryFile(prefix="ltx2_in_", suffix=".png", delete=False)
    img.save(tf, format="PNG")
    tf.close()
    return tf.name, (w, h)


def _run_inference(
    req: I2VRequest,
    width: int,
    height: int,
    num_frames: int,
    image_path: str,
) -> bytes:
    """Synchronous: build inputs, call pipeline, encode video, return MP4 bytes.
    Caller owns the inference lock and status transitions."""
    from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
    from ltx_pipelines.utils.args import ImageConditioningInput
    from ltx_pipelines.utils.media_io import encode_video

    seed = req.seed if req.seed is not None else int(uuid.uuid4().int & 0x7FFFFFFF)
    logger.info(
        "i2v start: prompt=%d chars, %dx%d, num_frames=%d, seed=%d, fps=%.1f",
        len(req.prompt),
        width,
        height,
        num_frames,
        seed,
        FRAME_RATE,
    )

    # Image conditioning: anchor the source image at frame 0 with strength 1.0
    # (full-strength keyframe). frame_idx=0 → VideoConditionByLatentIndex
    # via combined_image_conditionings (helpers.py:153).
    image_conditioning = ImageConditioningInput(
        path=image_path, frame_idx=0, strength=1.0,
    )

    tiling_config = TilingConfig.default()

    out_path = tempfile.NamedTemporaryFile(prefix="ltx2_out_", suffix=".mp4", delete=False).name

    t0 = time.monotonic()
    video_iterator, audio = holder.pipeline(
        prompt=req.prompt,
        seed=seed,
        height=height,
        width=width,
        num_frames=num_frames,
        frame_rate=FRAME_RATE,
        images=[image_conditioning],
        tiling_config=tiling_config,
        enhance_prompt=False,
    )
    logger.info("pipeline call returned in %.1fs; encoding video ...", time.monotonic() - t0)

    chunks = get_video_chunks_number(num_frames, tiling_config)
    encode_video(
        video=video_iterator,
        fps=int(FRAME_RATE),
        audio=audio,
        output_path=out_path,
        video_chunks_number=chunks,
    )
    logger.info("encode_video done; reading bytes ...")

    try:
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass


@app.post("/i2v")
async def i2v(request: Request):
    holder.touch_idle()

    payload = await request.json()
    try:
        req = I2VRequest.model_validate(payload)
    except ValidationError as e:
        return JSONResponse(
            status_code=400,
            content=error_envelope("VALIDATION_ERROR", "invalid /i2v payload", {"errors": e.errors()}),
        )

    try:
        image_path, (img_w, img_h) = _decode_image_to_temp(req.image_base64)
    except Exception as e:
        return JSONResponse(
            status_code=400,
            content=error_envelope("VALIDATION_ERROR", f"imageBase64 not a valid image: {e}"),
        )

    width, height = RESOLUTION_DIMS[req.resolution]
    num_frames = _frames_for_duration(req.duration_seconds)
    actual_duration = num_frames / FRAME_RATE

    # Build a streaming generator that holds the inference lock for its
    # duration. The pipeline call is synchronous; we run it in a thread and
    # emit periodic in_progress heartbeats so the render-api SSE pipe stays
    # alive on multi-minute calls. Final event is `completed` (or `error`).
    def stream():
        t_start = time.monotonic()
        yield _ndjson_line({
            "type": "started",
            "promptChars": len(req.prompt),
            "imageDims": [img_w, img_h],
            "durationSeconds": round(actual_duration, 3),
            "numFrames": num_frames,
            "resolution": req.resolution,
            "outputDims": [width, height],
        })

        result_holder: dict = {"video": None, "error": None}

        def worker():
            try:
                # Acquire the lock here so /unload races wait for us (ZG-23).
                # ensure_loaded acquires the lock too, so do load first
                # without re-acquiring, then re-acquire for inference.
                if not holder.is_loaded():
                    with holder.lock.acquire_for_request():
                        if not holder.is_loaded():
                            holder.lock.set_status("loading")
                            try:
                                holder.load_inside_lock()
                                holder.lock.set_status("ready")
                            except Exception:
                                holder.lock.set_status("error")
                                raise

                with holder.lock.acquire_for_request():
                    holder.lock.set_status("busy")
                    try:
                        if torch.cuda.is_available():
                            torch.cuda.reset_peak_memory_stats()
                        result_holder["video"] = _run_inference(
                            req, width, height, num_frames, image_path,
                        )
                    finally:
                        holder.lock.set_status("ready")
            except Exception as e:
                logger.exception("i2v inference failed")
                result_holder["error"] = e

        t = threading.Thread(target=worker, name="ltx2-inference", daemon=True)
        t.start()

        # Heartbeat every 30 s while worker is alive.
        last_beat = time.monotonic()
        while t.is_alive():
            t.join(timeout=1.0)
            now = time.monotonic()
            if t.is_alive() and (now - last_beat) >= 30.0:
                last_beat = now
                yield _ndjson_line({
                    "type": "in_progress",
                    "elapsedSec": round(now - t_start, 1),
                })

        # Cleanup temp input file regardless of success/failure.
        try:
            os.unlink(image_path)
        except OSError:
            pass

        if result_holder["error"] is not None:
            yield _ndjson_line(error_envelope(
                "INTERNAL_ERROR",
                f"inference failed: {result_holder['error']}",
            ) | {"type": "error"})
            return

        video_bytes: bytes = result_holder["video"]
        elapsed_ms = int((time.monotonic() - t_start) * 1000)
        if torch.cuda.is_available():
            vram_peak_mib = torch.cuda.max_memory_allocated() // (1024 * 1024)
        else:
            vram_peak_mib = 0
        logger.info(
            "i2v done: %d bytes in %.1fs (VRAM peak %d MiB)",
            len(video_bytes),
            elapsed_ms / 1000.0,
            vram_peak_mib,
        )
        yield _ndjson_line({
            "type": "completed",
            "videoBase64": base64.b64encode(video_bytes).decode("ascii"),
            "videoBytes": len(video_bytes),
            "durationMs": elapsed_ms,
            "vramPeakMib": int(vram_peak_mib),
        })
        holder.touch_idle()

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# -- entry ----------------------------------------------------------------
def _main() -> None:
    if os.environ.get("PRE_WARM") == "1":
        logger.info("PRE_WARM=1 set; constructing pipeline at startup")
        try:
            holder.ensure_loaded()
        except Exception:
            logger.exception("PRE_WARM pipeline build failed; continuing with lazy load")

    uvicorn.run(app, host="127.0.0.1", port=7863)


if __name__ == "__main__":
    _main()
