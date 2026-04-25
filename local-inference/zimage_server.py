"""Z-Image-Turbo local-inference HTTP server (port 7862).

Wraps the in-tree `D:\\Z-Image` package (added to sys.path at import time).
Locked API contract:
- POST /generate     -> 200 image/png on success
- POST /unload       -> 200 idempotent, 409 if loading (ZG-31)
- GET  /healthz      -> {status, modelLoaded}
- GET  /healthz?ready=1 -> blocks until model loaded (ZG-7)

Single inference at a time via InferenceLock (FIFO; ZG-23). Model lazy-loads
on first /generate unless PRE_WARM=1. IdleUnloader drops the model after 90 s
idle (ZG-2).

VRAM fallback (ZG-1.4 / ZG-24): try BF16 first; on torch.cuda.OutOfMemoryError
during load, retry with FP16; if FP16 also OOMs, drop default resolution to
768x768 for that process. We do NOT invent FP8 quantization — the upstream
Z-Image API doesn't expose it.
"""
from __future__ import annotations

import io
import logging
import os
import sys
import time
from pathlib import Path
from typing import Literal, Optional

# Z-Image imports rely on being on sys.path before `from utils import ...`
# inside its own modules resolves. Insert before any zimage / utils import.
ZIMAGE_REPO = Path(r"D:\Z-Image")
ZIMAGE_SRC = ZIMAGE_REPO / "src"
if str(ZIMAGE_SRC) not in sys.path:
    sys.path.insert(0, str(ZIMAGE_SRC))

# HF cache lives on D: (the only volume with room). Set before any HF import
# so snapshot_download lands here. Z-Image's own `ensure_model_weights` puts
# weights in a model-path argument (see below); HF_HOME just controls the
# transient cache used by transformers' AutoModel/AutoTokenizer.
os.environ.setdefault("HF_HOME", r"D:\hf_cache")
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", r"D:\hf_cache\hub")

import torch  # noqa: E402
import uvicorn  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
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
LOG_PATH = LOG_DIR / "zimage.log"

logger = logging.getLogger("zimage")
logger.setLevel(logging.INFO)
_fh = logging.FileHandler(str(LOG_PATH), mode="a", encoding="utf-8")
_fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(_fh)
_sh = logging.StreamHandler(sys.stdout)
_sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(_sh)


# -- weight management ----------------------------------------------------
WEIGHTS_DIR = Path(r"D:\hf_cache\Tongyi-MAI--Z-Image-Turbo")
HF_REPO_ID = "Tongyi-MAI/Z-Image-Turbo"
# Default to plain `native` SDPA so PyTorch picks the best available kernel
# for the host GPU. Z-Image's `inference.py` uses `_native_flash` which forces
# SDPBackend.FLASH_ATTENTION; on Blackwell sm_120 with torch 2.11 cu128 that
# kernel is not available and dispatch raises "No available kernel". `native`
# lets SDPA fall through to cuDNN/math/efficient as needed.
ATTENTION_BACKEND = os.environ.get("ZIMAGE_ATTENTION", "native")


def _ensure_weights() -> Path:
    """Ensure Z-Image-Turbo weights exist at WEIGHTS_DIR.

    Bypasses Z-Image's `ensure_model_weights` because it relies on a manifest
    keyed by the directory's lowercase basename ("z-image-turbo"). Our cache
    dir uses the canonical HF naming ("Tongyi-MAI--Z-Image-Turbo"); manifest
    lookup would miss and fall back to a per-dir manifest we don't have.
    Direct snapshot_download is simpler and gives us deterministic placement.
    """
    from huggingface_hub import snapshot_download

    sentinel = WEIGHTS_DIR / "model_index.json"
    if sentinel.exists():
        logger.info("weights already present at %s", WEIGHTS_DIR)
        return WEIGHTS_DIR

    logger.info("downloading %s -> %s", HF_REPO_ID, WEIGHTS_DIR)
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=HF_REPO_ID,
        local_dir=str(WEIGHTS_DIR),
        resume_download=True,
    )
    logger.info("download complete")
    return WEIGHTS_DIR


# -- model holder ---------------------------------------------------------
DEFAULT_DTYPE = torch.bfloat16
DEFAULT_DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Aspect-ratio dimensions. Z-Image's VAE has 4 block_out_channels →
# vae_scale_factor = 8 → vae_scale = 16, so generate() rejects any height/width
# not divisible by 16. The brief says "16:9 → 1920×1080" but 1080 % 16 = 8;
# we round to the nearest valid multiple-of-16 envelope (1920×1088, ratio
# 1.7647 vs ideal 1.7778 — visually indistinguishable). Width stays 1920 so
# downstream consumers crop/letterbox identically to a true 1080-tall frame.
ASPECT_DIMS = {
    "16:9": (1920, 1088),
    "9:16": (1088, 1920),
    "1:1": (1024, 1024),
}

# Quality presets — Turbo defaults to 8 NFE / cfg=0.0 per inference.py:21-22.
# 'basic' lowers steps a touch for marginal speed; resolution stays the same
# unless we hit OOM-fallback (see _ModelState.fallback_max_dim).
QUALITY_STEPS = {"high": 8, "basic": 6}


class _ModelState:
    """Mutable per-process settings adjusted by OOM fallbacks."""

    dtype: torch.dtype = DEFAULT_DTYPE
    fallback_max_dim: Optional[int] = None  # None = no clamp; e.g. 768 after double-OOM


class ModelHolder:
    """Owns the Z-Image components dict (`generate(**components, ...)`)."""

    def __init__(self) -> None:
        self.lock = InferenceLock()
        self._components: Optional[dict] = None
        self._state = _ModelState()
        self._idle = IdleUnloader(self._idle_unload, idle_seconds=90.0)
        self._attn_set = False

    def is_loaded(self) -> bool:
        return self._components is not None

    def _try_load(self, dtype: torch.dtype) -> dict:
        """Single load attempt at a given dtype. Raises on failure."""
        from utils import load_from_local_dir, set_attention_backend

        weights_dir = _ensure_weights()
        components = load_from_local_dir(
            weights_dir,
            device=DEFAULT_DEVICE,
            dtype=dtype,
            compile=False,
        )
        if not self._attn_set:
            try:
                set_attention_backend(ATTENTION_BACKEND)
                logger.info("attention backend: %s", ATTENTION_BACKEND)
                self._attn_set = True
            except Exception as e:
                logger.warning("set_attention_backend(%s) failed: %s", ATTENTION_BACKEND, e)
        return components

    def load_inside_lock(self) -> None:
        """Load weights. CALLER must already hold the inference lock and
        have set status='loading'. Honors BF16 -> FP16 OOM fallback."""
        if self._components is not None:
            return
        # Belt-and-braces: patch safetensors default to CUDA. Z-Image's loader
        # passes explicit device= so the patch is a no-op for its loads;
        # harmless and keeps behavior consistent across servers (LTX-2 will
        # rely on it more directly).
        patch_safetensors_to_cuda()

        logger.info("loading Z-Image-Turbo (BF16) ...")
        t0 = time.monotonic()
        try:
            self._components = self._try_load(torch.bfloat16)
            self._state.dtype = torch.bfloat16
            logger.info("loaded BF16 in %.1fs", time.monotonic() - t0)
        except torch.cuda.OutOfMemoryError:
            logger.warning("BF16 load OOM; clearing cache + retrying FP16")
            torch.cuda.empty_cache()
            self._components = self._try_load(torch.float16)
            self._state.dtype = torch.float16
            logger.info("loaded FP16 in %.1fs", time.monotonic() - t0)

    def ensure_loaded(self) -> None:
        """Lock-acquiring wrapper. Used by /healthz?ready=1 and PRE_WARM only;
        inside /generate we call load_inside_lock() under the request lock to
        avoid racing idle-unload."""
        if self._components is not None:
            return
        with self.lock.acquire_for_request():
            if self._components is not None:
                return
            self.lock.set_status("loading")
            try:
                self.load_inside_lock()
                self.lock.set_status("ready")
            except Exception:
                self.lock.set_status("error")
                self._components = None
                raise

    def unload(self) -> None:
        if self._components is None:
            return
        logger.info("unloading Z-Image-Turbo ...")
        for k in ("transformer", "vae", "text_encoder"):
            comp = self._components.get(k)
            if comp is not None:
                try:
                    comp.to("cpu")
                except Exception:
                    pass
        self._components = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
        logger.info("Z-Image-Turbo unloaded")

    def _idle_unload(self) -> None:
        if self._components is None:
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
    def components(self) -> dict:
        assert self._components is not None
        return self._components

    @property
    def state(self) -> _ModelState:
        return self._state


holder = ModelHolder()


# -- request schema -------------------------------------------------------
class GenerateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    prompt: str = Field(..., min_length=10, max_length=2000)
    negative_prompt: str = Field(default="", alias="negativePrompt", max_length=2000)
    aspect_ratio: Literal["16:9", "9:16", "1:1"] = Field(default="16:9", alias="aspectRatio")
    quality: Literal["high", "basic"] = Field(default="high")
    seed: Optional[int] = Field(default=None)


# -- app ------------------------------------------------------------------
app = make_app(holder, "Z-Image-Turbo")


def _resolve_dims(aspect: str, fallback_max_dim: Optional[int]) -> tuple[int, int]:
    w, h = ASPECT_DIMS[aspect]
    if fallback_max_dim is not None:
        # Maintain aspect; clamp the longer side to fallback_max_dim, then
        # round both sides to a multiple of 16 (vae_scale).
        scale = fallback_max_dim / max(w, h)
        if scale < 1.0:
            w = max(16, int(round(w * scale / 16) * 16))
            h = max(16, int(round(h * scale / 16) * 16))
    return w, h


@app.post("/generate")
async def generate_image(payload: dict):
    holder.touch_idle()

    try:
        req = GenerateRequest.model_validate(payload)
    except ValidationError as e:
        return JSONResponse(
            status_code=400,
            content=error_envelope("VALIDATION_ERROR", "invalid /generate payload", {"errors": e.errors()}),
        )

    width, height = _resolve_dims(req.aspect_ratio, holder.state.fallback_max_dim)
    steps = QUALITY_STEPS[req.quality]
    if req.quality == "basic":
        # log a one-time note: Turbo's 8-step distillation is the design point;
        # dropping to 6 is a small speed win at marginal-but-visible quality cost.
        logger.info("quality='basic' -> %d steps (Turbo design point is 8)", steps)

    try:
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()

        with holder.lock.acquire_for_request():
            # Load (or reload after an idle-unload race) inside the lock, so
            # no idle-unload can happen between is_loaded check and inference.
            if not holder.is_loaded():
                holder.lock.set_status("loading")
                try:
                    holder.load_inside_lock()
                    holder.lock.set_status("ready")
                except Exception as e:
                    holder.lock.set_status("error")
                    logger.exception("model load failed inside request lock")
                    return JSONResponse(
                        status_code=500,
                        content=error_envelope("INTERNAL_ERROR", f"model load failed: {e}"),
                    )
            holder.lock.set_status("busy")
            try:
                from zimage import generate as zimage_generate

                logger.info(
                    "generate: prompt=%d chars, neg=%d chars, %dx%d, steps=%d, seed=%s, dtype=%s",
                    len(req.prompt),
                    len(req.negative_prompt),
                    width,
                    height,
                    steps,
                    req.seed,
                    holder.state.dtype,
                )
                t0 = time.monotonic()
                gen = (
                    torch.Generator(DEFAULT_DEVICE).manual_seed(req.seed)
                    if req.seed is not None
                    else None
                )
                try:
                    images = zimage_generate(
                        prompt=req.prompt,
                        **holder.components,
                        height=height,
                        width=width,
                        num_inference_steps=steps,
                        guidance_scale=0.0,  # Turbo design point per inference.py:22
                        negative_prompt=req.negative_prompt or None,
                        generator=gen,
                    )
                except torch.cuda.OutOfMemoryError:
                    # Generation OOM (not load OOM). Clamp resolution and retry once.
                    if holder.state.fallback_max_dim is None:
                        holder.state.fallback_max_dim = 768
                        logger.warning(
                            "generate OOM at %dx%d; setting fallback_max_dim=768 and retrying",
                            width,
                            height,
                        )
                        torch.cuda.empty_cache()
                        width, height = _resolve_dims(req.aspect_ratio, 768)
                        gen = (
                            torch.Generator(DEFAULT_DEVICE).manual_seed(req.seed)
                            if req.seed is not None
                            else None
                        )
                        images = zimage_generate(
                            prompt=req.prompt,
                            **holder.components,
                            height=height,
                            width=width,
                            num_inference_steps=steps,
                            guidance_scale=0.0,
                            negative_prompt=req.negative_prompt or None,
                            generator=gen,
                        )
                    else:
                        raise
                duration = time.monotonic() - t0
                vram_peak_mib = (
                    torch.cuda.max_memory_allocated() // (1024 * 1024)
                    if torch.cuda.is_available()
                    else 0
                )
                logger.info(
                    "generate done in %.2fs at %dx%d (VRAM peak %d MiB)",
                    duration,
                    width,
                    height,
                    vram_peak_mib,
                )
            finally:
                holder.lock.set_status("ready")
    except Exception as e:
        logger.exception("generate inference failed")
        return JSONResponse(
            status_code=500,
            content=error_envelope("INTERNAL_ERROR", f"inference failed: {e}"),
        )

    if not images:
        return JSONResponse(
            status_code=500,
            content=error_envelope("INTERNAL_ERROR", "generate returned no images"),
        )

    buf = io.BytesIO()
    images[0].save(buf, format="PNG")
    holder.touch_idle()
    return Response(content=buf.getvalue(), media_type="image/png")


# -- entry ---------------------------------------------------------------
def _main() -> None:
    if os.environ.get("PRE_WARM") == "1":
        logger.info("PRE_WARM=1 set; loading model at startup")
        try:
            holder.ensure_loaded()
        except Exception:
            logger.exception("PRE_WARM model load failed; continuing with lazy load")

    uvicorn.run(app, host="127.0.0.1", port=7862)


if __name__ == "__main__":
    _main()
