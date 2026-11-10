"""Local Kokoro speech synthesis. Model downloads happen only during setup."""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import math
import os
import select
import subprocess
import sys
import urllib.request
import wave
from pathlib import Path

import numpy as np

MAX_TEXT = 2000
SAMPLE_RATE = 24000
DEFAULT_VOICE = "af_heart"
VOICE_IDS = (
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky",
    "am_adam", "am_michael", "bf_emma", "bf_isabella", "bm_george", "bm_lewis",
)
VOICES = [
    {"id": voice, "name": f"{voice[3:].capitalize()} · "
     f"{'British' if voice[0] == 'b' else 'American'} "
     f"{'female' if voice[1] == 'f' else 'male'}"}
    for voice in VOICE_IDS
]
ASSETS = {
    "kokoro-v1.0.onnx": "beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}
RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1"


class SpeechUnavailable(RuntimeError):
    pass


class SpeechBusy(RuntimeError):
    pass


class SpeechFailure(RuntimeError):
    pass


def model_directory(avatar_directory="models/avatar"):
    return Path(os.getenv("OPENSPLINE_TTS_MODEL_DIR", str(Path(avatar_directory).parent / "kokoro")))


def isolated_runtime():
    """Find the optional Kokoro environment without importing its binary packages."""
    candidate = Path(os.getenv(
        "OPENSPLINE_TTS_PYTHON", str(Path(sys.prefix).parent / ".venv-kokoro/bin/python")
    ))
    packages = candidate.parent.parent / "lib"
    if candidate.is_file() and any(packages.glob("python*/site-packages/kokoro_onnx/__init__.py")):
        # Preserve the venv path: resolving its interpreter symlink loses the venv.
        return candidate.absolute()
    return None


def validate_speech(body):
    if not isinstance(body, dict):
        raise ValueError("Enter text, a voice and a speech speed.")
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Enter some text for the avatar to say.")
    text = text.strip()
    if len(text) > MAX_TEXT:
        raise ValueError(f"Text must be {MAX_TEXT:,} characters or fewer.")
    if any(ord(char) < 32 and char not in "\n\r\t" for char in text):
        raise ValueError("Text contains unsupported control characters.")
    voice = body.get("voice", DEFAULT_VOICE)
    if not isinstance(voice, str) or voice not in VOICE_IDS:
        raise ValueError("Choose an available Kokoro voice.")
    speed = body.get("speed", 1.0)
    if type(speed) not in (int, float) or not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
        raise ValueError("Speech speed must be between 0.5 and 2.0.")
    return text, voice, float(speed)


def encode_wav(samples, rate):
    samples = np.asarray(samples, dtype=np.float32)
    if rate != SAMPLE_RATE or samples.ndim != 1 or not len(samples):
        raise SpeechFailure("Kokoro did not return a valid speech recording.")
    if len(samples) > SAMPLE_RATE * 180:
        raise SpeechFailure("Speech exceeds three minutes. Please use less text.")
    if not np.isfinite(samples).all() or not np.any(samples):
        raise SpeechFailure("Kokoro returned empty or invalid audio. Try another sentence.")
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
    data = io.BytesIO()
    with wave.open(data, "wb") as wav:
        wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        wav.writeframes(pcm)
    return data.getvalue()


class KokoroSpeech:
    def __init__(self, directory, runtime_dir="runtime"):
        self.directory = Path(directory)
        self.runtime_dir = Path(runtime_dir)
        self._engine = None
        self._inflight = None
        self._worker = None
        self._worker_log = None

    def status(self):
        installed = importlib.util.find_spec("kokoro_onnx") is not None or isolated_runtime() is not None
        models = all((self.directory / name).is_file() and (self.directory / name).stat().st_size
                     for name in ASSETS)
        ready = bool(installed and models)
        return {
            "ready": ready, "local": True, "engine": "Kokoro", "max_characters": MAX_TEXT,
            "default_voice": DEFAULT_VOICE, "voices": VOICES,
            "message": "Speech is generated on this Mac. No API key is needed." if ready else
            "Local speech needs setup. Run sh setup-kokoro.sh in Terminal, then restart OpenSpline.",
        }

    def _generate(self, text, voice, speed):
        if self._engine is None:
            if not self.status()["ready"]:
                raise SpeechUnavailable(self.status()["message"])
            if importlib.util.find_spec("kokoro_onnx") is None:
                return self._generate_isolated(text, voice, speed)
            try:
                import onnxruntime as ort
                from kokoro_onnx import Kokoro

                ort.disable_telemetry_events()
                options = ort.SessionOptions()
                options.intra_op_num_threads = 4
                options.inter_op_num_threads = 1
                session = ort.InferenceSession(
                    str(self.directory / "kokoro-v1.0.onnx"), sess_options=options,
                    providers=["CPUExecutionProvider"],
                )
                self._engine = Kokoro.from_session(session, str(self.directory / "voices-v1.0.bin"))
            except Exception as exc:
                raise SpeechUnavailable(
                    "Kokoro could not load its local model. Run sh setup-kokoro.sh, then restart OpenSpline."
                ) from exc
        try:
            samples, rate = self._engine.create(
                text, voice=voice, speed=speed, lang="en-gb" if voice.startswith("b") else "en-us"
            )
        except Exception as exc:
            raise SpeechFailure("Kokoro could not speak that text. Try another sentence or voice.") from exc
        return encode_wav(samples, rate)

    def _generate_isolated(self, text, voice, speed):
        runtime = isolated_runtime()
        if runtime is None:
            raise SpeechUnavailable("Kokoro needs setup. Run sh setup-kokoro.sh, then restart OpenSpline.")
        if self._worker is None or self._worker.poll() is not None:
            self._close_worker()
            self.runtime_dir.mkdir(parents=True, exist_ok=True)
            self._worker_log = (self.runtime_dir / "kokoro-worker.log").open("ab")
            environment = os.environ.copy()
            environment.pop("PYTHONPATH", None)
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            try:
                self._worker = subprocess.Popen(
                    [str(runtime), str(Path(__file__).resolve()), "--worker", "--directory", str(self.directory.resolve())],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._worker_log,
                    text=True, encoding="utf-8", bufsize=1, env=environment,
                )
            except OSError as exc:
                self._close_worker()
                raise SpeechUnavailable("Kokoro could not start. Run sh setup-kokoro.sh again.") from exc
        worker = self._worker
        try:
            worker.stdin.write(json.dumps({"text": text, "voice": voice, "speed": speed}) + "\n")
            worker.stdin.flush()
            if not select.select([worker.stdout], [], [], 120)[0]:
                self._close_worker()
                raise SpeechFailure("Kokoro took too long to generate speech. Try a shorter sentence.")
            line = worker.stdout.readline(16 * 1024 * 1024)
            if not line.endswith("\n"):
                raise ValueError("Incomplete worker response")
            response = json.loads(line)
            if response.get("ok") is True:
                return base64.b64decode(response["wav"], validate=True)
            if response.get("kind") == "unavailable":
                raise SpeechUnavailable(response["message"])
            raise SpeechFailure(response.get("message", "Kokoro could not generate speech."))
        except (OSError, ValueError, KeyError) as exc:
            self._close_worker()
            raise SpeechUnavailable(
                "The local Kokoro process stopped. Try Preview voice again; details are in runtime/kokoro-worker.log."
            ) from exc

    def _close_worker(self):
        worker, self._worker = self._worker, None
        if worker is not None:
            with contextlib.suppress(OSError):
                worker.stdin.close()
            try:
                worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                worker.terminate()
                try:
                    worker.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait()
            worker.stdout.close()
        if self._worker_log is not None:
            self._worker_log.close()
            self._worker_log = None

    async def synthesize(self, body):
        text, voice, speed = validate_speech(body)
        if self._inflight is not None and not self._inflight.done():
            raise SpeechBusy("Kokoro is finishing another speech request. Please try again shortly.")
        task = self._inflight = asyncio.create_task(asyncio.to_thread(self._generate, text, voice, speed))

        def finished(done):
            if self._inflight is done:
                self._inflight = None
            if not done.cancelled():
                done.exception()  # Consume errors even if the requesting browser disconnected.

        task.add_done_callback(finished)
        # Cancellation must not admit a second request while the CPU thread still runs.
        return await asyncio.shield(task)

    async def close(self):
        if self._inflight is not None:
            await asyncio.gather(asyncio.shield(self._inflight), return_exceptions=True)
        await asyncio.to_thread(self._close_worker)


def worker_main(directory):
    """One cached CPU model behind a private stdin/stdout pipe; no network service."""
    if importlib.util.find_spec("kokoro_onnx") is None:
        print(json.dumps({"ok": False, "kind": "unavailable", "message":
            "The Kokoro environment is incomplete. Run sh setup-kokoro.sh again."}), flush=True)
        return
    speech = KokoroSpeech(directory)
    for line in sys.stdin:
        try:
            text, voice, speed = validate_speech(json.loads(line))
            audio = speech._generate(text, voice, speed)
            response = {"ok": True, "wav": base64.b64encode(audio).decode("ascii")}
        except SpeechUnavailable as exc:
            response = {"ok": False, "kind": "unavailable", "message": str(exc)}
        except (SpeechFailure, ValueError) as exc:
            response = {"ok": False, "kind": "generation", "message": str(exc)}
        print(json.dumps(response), flush=True)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def prepare(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in ASSETS.items():
        path = directory / name
        if path.is_file() and sha256(path) == expected:
            print(f"Verified cached {name}", flush=True)
            continue
        partial = directory / (name + ".part")
        try:
            print(f"Downloading {name} from the Kokoro ONNX release...", flush=True)
            with urllib.request.urlopen(f"{RELEASE}/{name}", timeout=60) as response, partial.open("wb") as out:
                while block := response.read(1024 * 1024):
                    out.write(block)
            if sha256(partial) != expected:
                raise RuntimeError(f"Checksum mismatch for {name}; rerun setup to download it again")
            partial.replace(path)
        finally:
            partial.unlink(missing_ok=True)
    (directory / "manifest.json").write_text(json.dumps({"release": RELEASE, "sha256": ASSETS}, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Set up or test local Kokoro speech")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--directory", type=Path, default=model_directory())
    parser.add_argument("--output", type=Path, default=Path("runtime/kokoro-smoke.wav"))
    parser.add_argument("--text", default="Hello! This voice is generated locally with Kokoro on this Mac.")
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        worker_main(args.directory)
        return
    if args.prepare:
        prepare(args.directory)
    speech = KokoroSpeech(args.directory)
    async def sample():
        try:
            return await speech.synthesize({"text": args.text, "voice": args.voice})
        finally:
            await speech.close()
    try:
        audio = asyncio.run(sample())
    except (SpeechUnavailable, SpeechFailure) as exc:
        parser.exit(1, f"{exc}\n")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(audio)
    print(f"Kokoro generated local speech: {args.output}")


if __name__ == "__main__":
    main()
