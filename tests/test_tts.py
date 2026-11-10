import asyncio
import base64
import hashlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import av
import numpy as np
from fastapi.testclient import TestClient

from openspline_server.app import create_app
from openspline_server.config import Settings
from openspline_server.tts import (
    ASSETS, MAX_TEXT, KokoroSpeech, SpeechBusy, SpeechFailure, SpeechUnavailable,
    encode_wav, isolated_runtime, prepare, validate_speech, worker_main,
)


class Engine:
    def __init__(self):
        self.calls = []

    def create(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return (0.15 * np.sin(np.arange(7200) * 0.1)).astype(np.float32), 24000


class SpeechInputTests(unittest.TestCase):
    def test_defaults_and_whitespace(self):
        self.assertEqual(validate_speech({"text": "  Hello!\n"}), ("Hello!", "af_heart", 1.0))

    def test_invalid_input_never_reaches_model(self):
        for body in [None, [], {}, {"text": "  "}, {"text": 4}, {"text": "x" * (MAX_TEXT + 1)},
                     {"text": "hello\0there"}, {"text": "Hello", "voice": "../voice"},
                     {"text": "Hello", "speed": True}, {"text": "Hello", "speed": "fast"},
                     {"text": "Hello", "speed": float("nan")}, {"text": "Hello", "speed": float("inf")},
                     {"text": "Hello", "speed": 0.49}, {"text": "Hello", "speed": 2.01}]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                validate_speech(body)

    def test_audio_is_playable_mono_pcm_at_24khz(self):
        audio = encode_wav(np.array([-2, -.5, 0, .5, 2]), 24000)
        with wave.open(io.BytesIO(audio), "rb") as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 24000))
            self.assertEqual(np.frombuffer(wav.readframes(5), dtype="<i2").tolist(), [-32767, -16383, 0, 16383, 32767])

    def test_empty_nonfinite_or_malformed_audio_is_rejected(self):
        for samples, rate in [(np.array([]), 24000), (np.array([np.nan]), 24000),
                              (np.ones((2, 2)), 24000), (np.ones(5), 22050), (np.zeros(8), 24000)]:
            with self.subTest(rate=rate), self.assertRaises(SpeechFailure):
                encode_wav(samples, rate)


class SpeechServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_engine_is_reused_with_voice_language_and_speed(self):
        speech = KokoroSpeech("unused")
        speech._engine = engine = Engine()
        await speech.synthesize({"text": "First", "voice": "bf_emma", "speed": 1.25})
        await speech.synthesize({"text": "Second", "voice": "af_heart"})
        self.assertEqual(engine.calls, [
            ("First", {"voice": "bf_emma", "speed": 1.25, "lang": "en-gb"}),
            ("Second", {"voice": "af_heart", "speed": 1.0, "lang": "en-us"}),
        ])

    async def test_cancelled_browser_does_not_allow_overlapping_cpu_inference(self):
        speech = KokoroSpeech("unused")
        started, release = threading.Event(), threading.Event()

        def generate(*args):
            started.set()
            if not release.wait(5):
                raise RuntimeError("Test did not release inference")
            return b"wave"

        with patch.object(speech, "_generate", side_effect=generate):
            request = asyncio.create_task(speech.synthesize({"text": "First"}))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                with self.assertRaises(SpeechBusy):
                    await speech.synthesize({"text": "Second"})
                request.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await request
                with self.assertRaises(SpeechBusy):
                    await speech.synthesize({"text": "Third"})
            finally:
                release.set()
                await speech.close()
            self.assertEqual(await speech.synthesize({"text": "Next"}), b"wave")

    async def test_failed_request_releases_service(self):
        speech = KokoroSpeech("unused")
        with patch.object(speech, "_generate", side_effect=[SpeechFailure("failed"), b"next"]):
            with self.assertRaises(SpeechFailure):
                await speech.synthesize({"text": "First"})
            self.assertEqual(await speech.synthesize({"text": "Second"}), b"next")


class SpeechAPITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.app = create_app(Settings(backend="test", runtime_dir=self.temporary.name))
        self.client = TestClient(self.app)
        self.app.state.speech._engine = Engine()

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def test_status_is_local_and_has_no_paths_or_credentials(self):
        response = self.client.get("/v1/tts")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["local"])
        self.assertEqual(response.json()["default_voice"], "af_heart")
        self.assertNotIn(str(self.app.state.speech.directory), response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_http_returns_audio_the_existing_file_decoder_can_read(self):
        response = self.client.post("/v1/tts", json={"text": "Hello", "voice": "bf_emma", "speed": .75})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.headers["content-type"].startswith("audio/wav"))
        self.assertEqual(response.headers["cache-control"], "no-store")
        with av.open(io.BytesIO(response.content)) as container:
            frames = list(container.decode(audio=0))
        self.assertEqual(sum(f.samples for f in frames), 7200)
        self.assertEqual(frames[0].sample_rate, 24000)

    def test_invalid_or_oversized_body_is_rejected(self):
        for body in [{"text": ""}, {"text": "hello", "speed": False}, {"text": "hello", "voice": "missing"}]:
            self.assertEqual(self.client.post("/v1/tts", json=body).status_code, 422)
        self.assertEqual(self.client.post("/v1/tts", content=b"not json").status_code, 422)
        self.assertEqual(self.client.post("/v1/tts", content=b"x" * 16385).status_code, 413)

    def test_unavailable_and_busy_errors_are_actionable(self):
        self.app.state.speech.synthesize = AsyncMock(side_effect=SpeechUnavailable("Run sh setup-kokoro.sh"))
        response = self.client.post("/v1/tts", json={"text": "Hello"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "tts_unavailable")
        self.app.state.speech.synthesize = AsyncMock(side_effect=SpeechBusy("Please wait"))
        response = self.client.post("/v1/tts", json={"text": "Hello"})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["retry-after"], "1")

    def test_page_exposes_text_voice_speed_and_download(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        for control in ['id="tts-text"', 'id="tts-voice"', 'id="tts-speed"', 'id="speech-download"',
                        'id="tts-preview-audio"', 'id="uploaded-audio-preview"']:
            self.assertIn(control, response.text)
        self.assertIn('value="kokoro" selected', response.text)
        self.assertIn('<button id="tts-preview-button" type="button"', response.text)
        self.assertIn('<option value="file">Upload voice audio</option>', response.text)


class AssetTests(unittest.TestCase):
    def test_existing_verified_assets_do_not_access_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "test.bin").write_bytes(b"model")
            with patch.dict(ASSETS, {"test.bin": hashlib.sha256(b"model").hexdigest()}, clear=True), patch(
                "urllib.request.urlopen", side_effect=AssertionError("Unexpected download")
            ):
                prepare(root)

    def test_failed_download_checksum_preserves_existing_asset(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "test.bin").write_bytes(b"old")
            with patch.dict(ASSETS, {"test.bin": hashlib.sha256(b"good").hexdigest()}, clear=True), patch(
                "urllib.request.urlopen", return_value=io.BytesIO(b"bad")
            ), self.assertRaisesRegex(RuntimeError, "Checksum"):
                prepare(root)
            self.assertEqual((root / "test.bin").read_bytes(), b"old")
            self.assertFalse((root / "test.bin.part").exists())


class IsolatedRuntimeTests(unittest.TestCase):
    def test_incomplete_worker_runtime_fails_without_spawning_another_worker(self):
        output = io.StringIO()
        with patch("openspline_server.tts.importlib.util.find_spec", return_value=None), patch(
            "sys.stdout", output
        ), patch("openspline_server.tts.subprocess.Popen", side_effect=AssertionError("Recursive worker")):
            worker_main(Path("models/kokoro"))
        self.assertEqual(json.loads(output.getvalue())["kind"], "unavailable")

    def test_runtime_detection_preserves_the_virtualenv_interpreter_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            python = root / "bin/python"
            python.parent.mkdir()
            python.symlink_to(sys.executable)
            package = root / "lib/python3.12/site-packages/kokoro_onnx/__init__.py"
            package.parent.mkdir(parents=True)
            package.write_text("")
            with patch.dict(os.environ, OPENSPLINE_TTS_PYTHON=str(python)):
                self.assertEqual(isolated_runtime(), python.absolute())
            package.unlink()
            with patch.dict(os.environ, OPENSPLINE_TTS_PYTHON=str(python)):
                self.assertIsNone(isolated_runtime())

    def worker(self, response):
        worker = Mock()
        worker.stdin = io.StringIO()
        worker.stdout = io.StringIO(response)
        worker.poll.return_value = None
        worker.wait.return_value = 0
        return worker

    def test_worker_is_reused_and_text_only_travels_through_private_stdin(self):
        blob = encode_wav(np.ones(2400, dtype=np.float32) * .1, 24000)
        response = json.dumps({"ok": True, "wav": base64.b64encode(blob).decode()}) + "\n"
        worker = self.worker(response * 2)
        with tempfile.TemporaryDirectory() as temporary:
            speech = KokoroSpeech("models/kokoro", temporary)
            with patch("openspline_server.tts.isolated_runtime", return_value=Path("/runtime/bin/python")), patch(
                "openspline_server.tts.subprocess.Popen", return_value=worker
            ) as spawn, patch("openspline_server.tts.select.select", return_value=([worker.stdout], [], [])):
                self.assertEqual(speech._generate_isolated("Private speech", "bf_emma", .75), blob)
                self.assertEqual(speech._generate_isolated("Next sentence", "af_heart", 1), blob)
                spawn.assert_called_once()
                self.assertNotIn("Private speech", str(spawn.call_args.args))
                messages = [json.loads(line) for line in worker.stdin.getvalue().splitlines()]
                self.assertEqual(messages[0], {"text": "Private speech", "voice": "bf_emma", "speed": .75})
                self.assertNotIn("PYTHONPATH", spawn.call_args.kwargs["env"])
            speech._close_worker()
            self.assertTrue(worker.stdin.closed)
            self.assertTrue(worker.stdout.closed)
            self.assertIsNone(speech._worker)

    def test_bad_worker_output_is_closed_and_reported(self):
        worker = self.worker("invalid response\n")
        with tempfile.TemporaryDirectory() as temporary:
            speech = KokoroSpeech("models/kokoro", temporary)
            with patch("openspline_server.tts.isolated_runtime", return_value=Path("/runtime/bin/python")), patch(
                "openspline_server.tts.subprocess.Popen", return_value=worker
            ), patch("openspline_server.tts.select.select", return_value=([worker.stdout], [], [])):
                with self.assertRaises(SpeechUnavailable):
                    speech._generate_isolated("Hello", "af_heart", 1)
            self.assertIsNone(speech._worker)
            self.assertTrue(worker.stdout.closed)


@unittest.skipUnless(os.getenv("OPENSPLINE_KOKORO_INTEGRATION") == "1", "Real Kokoro smoke test is opt-in")
class RealKokoroTests(unittest.TestCase):
    def test_actual_http_synthesis_worker_reuse_and_shutdown(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = create_app(Settings(backend="test", runtime_dir=temporary))
            client = TestClient(app)
            try:
                self.assertTrue(client.get("/v1/tts").json()["ready"])
                first = client.post("/v1/tts", json={"text": "This voice preview is generated locally.", "voice": "bf_emma"})
                self.assertEqual(first.status_code, 200, first.text)
                process = app.state.speech._worker
                with wave.open(io.BytesIO(first.content), "rb") as wav:
                    self.assertEqual(wav.getframerate(), 24000)
                    self.assertGreater(wav.getnframes(), 2400)
                second = client.post("/v1/tts", json={"text": "A second voice preview.", "voice": "af_heart"})
                self.assertEqual(second.status_code, 200)
                self.assertIs(app.state.speech._worker, process)
            finally:
                client.close()
                process = app.state.speech._worker
                asyncio.run(app.state.speech.close())
                self.assertTrue(process is None or process.poll() is not None)


if __name__ == "__main__":
    unittest.main()
