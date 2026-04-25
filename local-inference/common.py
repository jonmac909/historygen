"""Shared scaffolding for local-inference Python servers.

Used by voxcpm2_server.py, zimage_server.py, ltx2_server.py.
Provides: IdleUnloader, InferenceLock (FIFO + status), error envelope,
and a FastAPI app factory wiring /healthz and /unload per the locked
contract (ZG-2, ZG-7, ZG-22, ZG-23, ZG-31).
"""
from __future__ import annotations

import gc
import threading
import time
from collections import deque
from typing import Callable, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse


VALID_ERROR_CODES = {"VALIDATION_ERROR", "NOT_FOUND", "RATE_LIMITED", "INTERNAL_ERROR", "BUSY"}


def patch_safetensors_to_cuda(target_device: str = "cuda") -> None:
    """Force safetensors.torch.load_file to load directly onto the target device.

    Why: many model loaders call `load_file(path)` and rely on the default
    CPU mmap. On low-pagefile Windows boxes, large safetensors (e.g. VoxCPM2's
    4.4 GB or LTX-2's ~22 GB) blow the commit limit and segfault during mmap.
    Loading straight to CUDA bypasses the host-RAM mmap entirely.

    Idempotent: only patches if CUDA is available and not already patched.
    Note: callers that pass an explicit `device=` arg to `load_file` bypass
    this default and remain unaffected (this is intentional — Z-Image's loader
    deliberately stages CPU→GPU; the patch only catches the implicit-default
    callers like VoxCPM2 and LTX-2).
    """
    import torch  # local import keeps common.py importable without torch
    if not torch.cuda.is_available():
        return
    import safetensors.torch as st  # type: ignore
    if getattr(st.load_file, "_patched_for_cuda", False):
        return
    _orig = st.load_file

    def _load_file_cuda(filename, device=target_device):  # match orig signature
        return _orig(filename, device=device)

    _load_file_cuda._patched_for_cuda = True  # type: ignore[attr-defined]
    st.load_file = _load_file_cuda  # type: ignore[assignment]


def error_envelope(code: str, message: str, details: Optional[dict] = None) -> dict:
    """Build the locked error envelope shape (ZG-22)."""
    if code not in VALID_ERROR_CODES:
        raise ValueError(f"unknown error code: {code}")
    return {"error": {"code": code, "message": message, "details": details}}


class ModelLoadingError(Exception):
    """Raised when an unload is attempted on a model in 'loading' state (ZG-31)."""


class InferenceLock:
    """FIFO lock with a status field. Wraps two-state coordination:
    request acquires + unload acquires, with unload blocked while loading."""

    VALID_STATUSES = ("idle", "loading", "ready", "busy", "error")

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._held = False
        self._waiters: deque[threading.Event] = deque()
        self._status: str = "idle"

    @property
    def status(self) -> str:
        with self._cv:
            return self._status

    def set_status(self, status: str) -> None:
        if status not in self.VALID_STATUSES:
            raise ValueError(f"invalid status: {status}")
        with self._cv:
            self._status = status
            self._cv.notify_all()

    def _acquire_fifo(self) -> None:
        ev = threading.Event()
        with self._cv:
            if not self._held and not self._waiters:
                self._held = True
                return
            self._waiters.append(ev)
        ev.wait()
        with self._cv:
            self._held = True

    def _release(self) -> None:
        with self._cv:
            self._held = False
            if self._waiters:
                ev = self._waiters.popleft()
                ev.set()
            self._cv.notify_all()

    class _Guard:
        def __init__(self, parent: "InferenceLock") -> None:
            self._parent = parent

        def __enter__(self) -> "InferenceLock":
            return self._parent

        def __exit__(self, exc_type, exc, tb) -> None:
            self._parent._release()

    def acquire_for_request(self) -> "InferenceLock._Guard":
        """Block until lock is free, FIFO order. Returns a context guard."""
        self._acquire_fifo()
        return self._Guard(self)

    def acquire_for_unload(self) -> "InferenceLock._Guard":
        """Like acquire_for_request, but raises ModelLoadingError if status='loading'.
        ZG-31: load is non-cancellable; caller returns 409 + Retry-After."""
        with self._cv:
            if self._status == "loading":
                raise ModelLoadingError("model is loading")
        self._acquire_fifo()
        with self._cv:
            if self._status == "loading":
                # status flipped to loading after we queued; release and bail
                self._held = False
                if self._waiters:
                    ev = self._waiters.popleft()
                    ev.set()
                self._cv.notify_all()
                raise ModelLoadingError("model is loading")
        return self._Guard(self)


class IdleUnloader:
    """Background timer thread that calls unload_callback after `idle_seconds`
    of no touches. touch() resets the timer; cancel() stops the thread."""

    def __init__(self, unload_callback: Callable[[], None], idle_seconds: float = 90.0) -> None:
        self._cb = unload_callback
        self._idle_seconds = idle_seconds
        self._lock = threading.Lock()
        self._deadline: Optional[float] = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="IdleUnloader")
        self._thread.start()

    def touch(self) -> None:
        with self._lock:
            self._deadline = time.monotonic() + self._idle_seconds

    def cancel(self) -> None:
        self._stop.set()
        with self._lock:
            self._deadline = None

    def _run(self) -> None:
        while not self._stop.is_set():
            with self._lock:
                deadline = self._deadline
            if deadline is None:
                time.sleep(0.5)
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                with self._lock:
                    self._deadline = None
                try:
                    self._cb()
                except Exception:
                    pass
                continue
            time.sleep(min(remaining, 1.0))


def make_app(model_holder, model_name: str) -> FastAPI:
    """Create a FastAPI app with /healthz and /unload pre-wired.

    `model_holder` must expose:
      - `lock: InferenceLock`
      - `is_loaded() -> bool`
      - `ensure_loaded() -> None`  (blocks until status='ready'; safe to call when ready)
      - `unload() -> None`         (sync: drops model handle, empties cache)
    """
    app = FastAPI(title=f"{model_name} local-inference server")

    @app.get("/healthz")
    def healthz(ready: int = 0):
        if ready == 1 and not model_holder.is_loaded():
            try:
                model_holder.ensure_loaded()
            except Exception as e:
                return JSONResponse(
                    status_code=503,
                    content=error_envelope("INTERNAL_ERROR", f"model load failed: {e}"),
                )
        return {"status": model_holder.lock.status, "modelLoaded": model_holder.is_loaded()}

    @app.post("/unload")
    def unload():
        if not model_holder.is_loaded() and model_holder.lock.status == "idle":
            return {"status": "idle", "modelLoaded": False}
        try:
            with model_holder.lock.acquire_for_unload():
                model_holder.unload()
                gc.collect()
                model_holder.lock.set_status("idle")
            return {"status": "idle", "modelLoaded": False}
        except ModelLoadingError:
            return JSONResponse(
                status_code=409,
                headers={"Retry-After": "30"},
                content=error_envelope("BUSY", "model is loading"),
            )

    return app
