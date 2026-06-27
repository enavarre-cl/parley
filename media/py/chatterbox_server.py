#!/usr/bin/env python3
"""Minimal local TTS daemon for Jotflow's Chatterbox (Resemble AI) engine.

Two interchangeable backends, chosen by --backend:
  - mlx   : Apple Silicon fast path — a 4-bit multilingual model via `mlx-audio` (no PyTorch),
            ~4x faster than the torch path and a fraction of the RAM/disk.
  - torch : cross-platform fallback — `chatterbox-tts` (PyTorch, MPS/CUDA/CPU).

Loads the model once (resident) and serves synthesis over loopback HTTP, so the chat does not
reload the model on every "read aloud". Stdlib HTTP only; binds to 127.0.0.1 exclusively.

Protocol:
  GET  /            -> 200 "ok"                      (readiness probe)
  POST /synthesize  -> 200 audio/wav | 4xx/5xx text  (body: JSON, see below)
    { "text": str, "ref_wav": str|null, "exaggeration": float|null,
      "cfg_weight": float|null, "language_id": str|null }
"""
import argparse
import io
import json
import os
import sys
import threading
import wave
# Single-threaded HTTPServer (not ThreadingHTTPServer): MLX's Metal GPU stream is thread-local and
# is set up in the main thread at load/warmup, so generation MUST run on that same thread. Synthesis
# is serialized anyway (one resident model), and readiness is only polled before the first request.
from http.server import BaseHTTPRequestHandler, HTTPServer

# Guards the one resident model (defensive; the server is single-threaded).
_LOCK = threading.Lock()


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def pcm_wav(float_arr, sr):
    """Builds a 16-bit mono WAV (bytes) from a float [-1,1] numpy array."""
    import numpy as np
    pcm = np.clip(np.asarray(float_arr, dtype=np.float32).reshape(-1), -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ───────────────────────── MLX backend (Apple Silicon) ─────────────────────────

def mlx_load(model_id):
    from mlx_audio.tts.utils import load_model
    return load_model(model_path=model_id)


def mlx_synth(model, text, ref_wav, exaggeration, cfg_weight, language_id):
    import numpy as np
    import mlx.core as mx
    kwargs = {"text": text, "lang_code": (language_id or "en"), "verbose": False}
    if ref_wav:
        kwargs["ref_audio"] = ref_wav
    if exaggeration is not None:
        kwargs["exaggeration"] = float(exaggeration)
    if cfg_weight is not None:
        kwargs["cfg_weight"] = float(cfg_weight)
    parts = []
    sr = 24000
    with _LOCK:
        for seg in model.generate(**kwargs):
            a = getattr(seg, "audio", None)
            if a is None:
                continue
            mx.eval(a)
            parts.append(np.asarray(a, dtype=np.float32).reshape(-1))
            sr = int(getattr(seg, "sample_rate", 24000))
    if not parts:
        raise RuntimeError("no audio produced")
    import numpy as np2
    return pcm_wav(np2.concatenate(parts), sr)


# ───────────────────────── torch backend (cross-platform) ─────────────────────────

def torch_pick_device(requested):
    import torch
    if requested and requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def torch_load(model_name, device):
    import torch
    _orig_load = torch.load

    def _patched_load(*a, **k):
        k.setdefault("map_location", torch.device(device))
        return _orig_load(*a, **k)

    torch.load = _patched_load
    if model_name == "multilingual":
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS as Model
    else:
        from chatterbox.tts import ChatterboxTTS as Model
    return Model.from_pretrained(device=device)


def torch_synth(model, text, ref_wav, exaggeration, cfg_weight, language_id):
    import torch
    kwargs = {}
    if ref_wav:
        kwargs["audio_prompt_path"] = ref_wav
    if exaggeration is not None:
        kwargs["exaggeration"] = float(exaggeration)
    if cfg_weight is not None:
        kwargs["cfg_weight"] = float(cfg_weight)
    if language_id:
        kwargs["language_id"] = language_id
    with _LOCK:
        with torch.no_grad():
            wav = model.generate(text, **kwargs)
    if not torch.is_tensor(wav):
        wav = torch.as_tensor(wav)
    if wav.dim() > 1:
        wav = wav.reshape(-1)
    import numpy as np
    return pcm_wav(np.asarray(wav.detach().to("cpu", dtype=torch.float32)), int(getattr(model, "sr", 24000)))


# ───────────────────────── HTTP server ─────────────────────────

def make_handler(synth):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            return

        def _send(self, code, content_type, body):
            try:
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                pass

        def do_GET(self):
            self._send(200, "text/plain", b"ok")

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception as e:
                self._send(400, "text/plain", ("bad request: %s" % e).encode("utf-8", "replace"))
                return
            text = (data.get("text") or "").strip()
            if not text:
                self._send(400, "text/plain", b"empty text")
                return
            try:
                wav = synth(text, data.get("ref_wav"), data.get("exaggeration"),
                            data.get("cfg_weight"), data.get("language_id"))
            except Exception as e:
                self._send(500, "text/plain", ("%s: %s" % (type(e).__name__, e)).encode("utf-8", "replace"))
                return
            self._send(200, "audio/wav", wav)

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="torch", choices=["torch", "mlx"])
    ap.add_argument("--model", default="english")       # torch: english | multilingual
    ap.add_argument("--mlx-model", default=None)         # mlx: HF repo id of the quantized model
    ap.add_argument("--device", default="auto")          # torch
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--hf-home", default=None)
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()
    if args.hf_home:
        os.environ.setdefault("HF_HOME", args.hf_home)
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(args.hf_home, "hub"))
    # Offline skips the per-start network revision checks (set before huggingface_hub imports).
    if args.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"

    if args.backend == "mlx":
        log("jotflow-chatterbox: loading MLX model=%s%s" % (args.mlx_model, " (offline cache)" if args.offline else ""))
        model = mlx_load(args.mlx_model)

        def synth(text, ref, exag, cfg, lang):
            return mlx_synth(model, text, ref, exag, cfg, lang)
        # Warm up the JIT once so the first real request is already compiled (fast).
        try:
            mlx_synth(model, "hola", None, None, None, "es")
            log("jotflow-chatterbox: MLX warmup done")
        except Exception as e:
            log("jotflow-chatterbox: MLX warmup skipped (%s)" % e)
    else:
        device = torch_pick_device(args.device)
        log("jotflow-chatterbox: loading torch model=%s device=%s%s" % (
            args.model, device, " (offline cache)" if args.offline else " (downloads weights if missing)"))
        model = torch_load(args.model, device)

        def synth(text, ref, exag, cfg, lang):
            return torch_synth(model, text, ref, exag, cfg, lang)

    httpd = HTTPServer((args.host, args.port), make_handler(synth))
    log("jotflow-chatterbox: ready on %s:%d" % (args.host, args.port))
    httpd.serve_forever()


if __name__ == "__main__":
    main()
