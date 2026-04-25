"""VoxCPM2 local-inference HTTP server (port 7861).

Wraps the pip-installed `voxcpm` package. Exposes the locked API contract:
- POST /tts          -> 200 audio/wav (48 kHz mono) on success
- POST /unload       -> 200 idempotent, 409 if loading (ZG-31)
- GET  /healthz      -> {status, modelLoaded}
- GET  /healthz?ready=1 -> blocks until model loaded (ZG-7)

Single inference at a time via InferenceLock (FIFO; ZG-23). Model lazy-loads
on first /tts unless PRE_WARM=1. IdleUnloader drops the model after 90 s
idle (ZG-2). Reference-audio cloning decodes base64 to a temp WAV, passes
the path to VoxCPM.generate(), cleans up afterward.
"""
from __future__ import annotations

import base64
import io
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
import torch
import torchaudio
import uvicorn
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from common import (
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
LOG_PATH = LOG_DIR / "voxcpm2.log"

logger = logging.getLogger("voxcpm2")
logger.setLevel(logging.INFO)
_fh = logging.FileHandler(str(LOG_PATH), mode="a", encoding="utf-8")
_fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(_fh)
_sh = logging.StreamHandler(sys.stdout)
_sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(_sh)


# -- model holder ---------------------------------------------------------
TARGET_SAMPLE_RATE = 48000


class ModelHolder:
    """Owns the VoxCPM model handle, lock, and idle unloader."""

    def __init__(self) -> None:
        self.lock = InferenceLock()
        self._model = None
        self._idle = IdleUnloader(self._idle_unload, idle_seconds=90.0)

    def is_loaded(self) -> bool:
        return self._model is not None

    def ensure_loaded(self) -> None:
        if self._model is not None:
            return
        with self.lock.acquire_for_request():
            if self._model is not None:
                return
            self.lock.set_status("loading")
            try:
                logger.info("loading VoxCPM2 model from openbmb/VoxCPM2 ...")
                patch_safetensors_to_cuda()
                from voxcpm import VoxCPM
                self._model = VoxCPM.from_pretrained(
                    hf_model_id="openbmb/VoxCPM2",
                    load_denoiser=False,
                    optimize=True,
                )
                logger.info(
                    "VoxCPM2 loaded (native sample_rate=%d)",
                    self._model.tts_model.sample_rate,
                )
                self.lock.set_status("ready")
            except Exception:
                self.lock.set_status("error")
                self._model = None
                raise

    def unload(self) -> None:
        if self._model is None:
            return
        logger.info("unloading VoxCPM2 model ...")
        del self._model
        self._model = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("VoxCPM2 unloaded")

    def _idle_unload(self) -> None:
        if self._model is None:
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
    def model(self):
        return self._model


holder = ModelHolder()


# -- request schema -------------------------------------------------------
class TTSRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    text: str = Field(..., min_length=5, max_length=500)
    reference_audio_base64: Optional[str] = Field(default=None, alias="referenceAudioBase64")
    reference_transcript: Optional[str] = Field(default=None, alias="referenceTranscript")
    emotion: Optional[str] = Field(default=None)
    temperature: float = Field(default=0.9, ge=0.5, le=1.5)
    top_p: float = Field(default=0.85, ge=0.0, le=1.0, alias="topP")
    repetition_penalty: float = Field(default=1.1, ge=1.0, le=2.0, alias="repetitionPenalty")
    seed: Optional[int] = Field(default=None)


# -- app ------------------------------------------------------------------
app = make_app(holder, "VoxCPM2")


@app.post("/tts")
async def tts(payload: dict):
    holder.touch_idle()

    try:
        req = TTSRequest.model_validate(payload)
    except ValidationError as e:
        return JSONResponse(
            status_code=400,
            content=error_envelope("VALIDATION_ERROR", "invalid /tts payload", {"errors": e.errors()}),
        )

    try:
        holder.ensure_loaded()
    except Exception as e:
        logger.exception("model load failed")
        return JSONResponse(
            status_code=500,
            content=error_envelope("INTERNAL_ERROR", f"model load failed: {e}"),
        )

    ref_path: Optional[str] = None
    if req.reference_audio_base64:
        try:
            audio_bytes = base64.b64decode(req.reference_audio_base64, validate=True)
        except Exception as e:
            return JSONResponse(
                status_code=400,
                content=error_envelope("VALIDATION_ERROR", f"referenceAudioBase64 not valid base64: {e}"),
            )
        tf = tempfile.NamedTemporaryFile(prefix="voxcpm2_ref_", suffix=".wav", delete=False)
        tf.write(audio_bytes)
        tf.close()
        ref_path = tf.name

    try:
        if req.seed is not None:
            torch.manual_seed(req.seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(req.seed)

        with holder.lock.acquire_for_request():
            holder.lock.set_status("busy")
            try:
                logger.info(
                    "tts: text=%d chars, ref=%s, temp=%.2f, top_p=%.2f, rep_pen=%.2f, seed=%s",
                    len(req.text),
                    "yes" if ref_path else "no",
                    req.temperature,
                    req.top_p,
                    req.repetition_penalty,
                    req.seed,
                )
                wav = holder.model.generate(
                    text=req.text,
                    prompt_wav_path=ref_path if (ref_path and req.reference_transcript) else None,
                    prompt_text=req.reference_transcript if (ref_path and req.reference_transcript) else None,
                    reference_wav_path=ref_path if (ref_path and not req.reference_transcript) else None,
                )
            finally:
                holder.lock.set_status("ready")
    except Exception as e:
        logger.exception("tts inference failed")
        return JSONResponse(
            status_code=500,
            content=error_envelope("INTERNAL_ERROR", f"inference failed: {e}"),
        )
    finally:
        if ref_path:
            try:
                os.unlink(ref_path)
            except OSError:
                pass

    wav_bytes = _wav_to_48k_mono_bytes(wav, holder.model.tts_model.sample_rate)
    holder.touch_idle()
    return Response(content=wav_bytes, media_type="audio/wav")


def _wav_to_48k_mono_bytes(wav: np.ndarray, src_sr: int) -> bytes:
    """Resample to 48 kHz mono PCM_16 WAV bytes."""
    if wav.ndim > 1:
        wav = wav.mean(axis=0) if wav.shape[0] < wav.shape[-1] else wav.mean(axis=-1)
    wav = np.asarray(wav, dtype=np.float32)
    if src_sr != TARGET_SAMPLE_RATE:
        t = torch.from_numpy(wav).unsqueeze(0)
        t = torchaudio.functional.resample(t, src_sr, TARGET_SAMPLE_RATE)
        wav = t.squeeze(0).numpy()
    buf = io.BytesIO()
    sf.write(buf, wav, TARGET_SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# -- entry ---------------------------------------------------------------
def _main() -> None:
    if os.environ.get("PRE_WARM") == "1":
        logger.info("PRE_WARM=1 set; loading model at startup")
        try:
            holder.ensure_loaded()
        except Exception:
            logger.exception("PRE_WARM model load failed; continuing with lazy load")

    uvicorn.run(app, host="127.0.0.1", port=7861)


if __name__ == "__main__":
    _main()
