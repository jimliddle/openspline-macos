"""Exercise the Mac's Low-only profile through the same API calls as Speak."""

import base64
import io
import os
import tempfile
import time
import unittest
import wave
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from PIL import Image

from openspline_server.app import create_app
from openspline_server.config import Settings
from openspline_server.worker import WorkerFailure, WorkerPool


def portrait():
    data = io.BytesIO()
    Image.new("RGB", (64, 64), "steelblue").save(data, format="PNG")
    return data.getvalue()


def finished(client, response):
    if response.status_code == 200:
        return response.json()
    assert response.status_code == 202, response.text
    path = "/v1/demo/quality/" + response.json()["id"]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        job = client.get(path).json()
        if job["state"] in {"ready", "error"}:
            return job
        time.sleep(.01)
    raise AssertionError("Avatar preparation did not finish")


class MacPreparationAPITests(unittest.TestCase):
    @unittest.skipUnless(os.getenv("OPENSPLINE_KOKORO_INTEGRATION") == "1", "Real Kokoro integration is opt-in")
    def test_typed_kokoro_speech_reaches_avatar_playback_and_releases_worker(self):
        with tempfile.TemporaryDirectory() as runtime:
            app = create_app(Settings(backend="test", runtime_dir=runtime))
            app.state.pool.demo_devices = {"low": (0,)}
            # Real Kokoro audio and real playback transport; CPU avatar frames, not Metal inference.
            with TestClient(app) as client:
                prepared = finished(client, client.post(
                    "/v1/demo/quality", json={"quality": "low", "devices": [0]},
                ))
                self.assertEqual(prepared["state"], "ready", prepared)
                speech = client.post("/v1/tts", json={"text": "Hello.", "voice": "af_heart"})
                self.assertEqual(speech.status_code, 200, speech.text)
                with wave.open(io.BytesIO(speech.content), "rb") as wav:
                    expected = wav.getnframes() * 48000 // wav.getframerate()
                session_response = client.post(
                    "/v1/sessions", data={"quality": "low"},
                    files={"portrait": ("portrait.png", portrait(), "image/png")},
                )
                self.assertEqual(session_response.status_code, 201, session_response.text)
                session = session_response.json()
                path = "/v1/sessions/" + session["id"]
                headers = {"Authorization": "Bearer " + session["publisher_token"]}
                with client.websocket_connect(path + "/playback") as viewer:
                    viewer.send_json({"token": session["token"]})
                    self.assertEqual(viewer.receive_json()["type"], "connected")
                    viewer.send_json({"type": "ready"})
                    while viewer.receive_json()["type"] != "playback_ready":
                        pass
                    with client.websocket_connect(path + "/audio") as publisher:
                        publisher.send_json({"token": session["publisher_token"]})
                        while publisher.receive_json()["type"] != "ready":
                            pass
                        uploaded = client.post(path + "/file", headers=headers, files={
                            "audio": ("kokoro-speech.wav", speech.content, "audio/wav"),
                        })
                        self.assertEqual(uploaded.status_code, 200, uploaded.text)
                        publisher.send_json({"type": "end_turn", "id": "speech-complete"})
                        played = packets = 0
                        while played < expected:
                            event = viewer.receive_json()
                            if event["type"] == "idle":
                                viewer.send_json({"type": "idle_played", "sequence": event["sequence"], "epoch": event["epoch"]})
                            if event["type"] == "media":
                                self.assertTrue(event["image"])
                                played += len(base64.b64decode(event["audio"])) // 2
                                packets += 1
                                viewer.send_json({"type": "played", "samples": event["samples"], "epoch": event["epoch"]})
                        while publisher.receive_json().get("id") != "speech-complete":
                            pass
                        self.assertEqual(played, expected)
                        self.assertGreater(packets, 0)
                        self.assertEqual(client.delete(path, headers=headers).status_code, 204)
                self.assertIsNone(app.state.pool.workers[0].owner)

    def test_low_only_gpu_selection_prepares_then_creates_two_sessions(self):
        with tempfile.TemporaryDirectory() as runtime:
            settings = Settings(backend="test", runtime_dir=runtime)
            saved = []
            settings.save_demo_selection = lambda devices, quality: saved.append((devices, quality))
            app = create_app(settings)
            # This is a transport/configuration test. The CPU backend does not test Metal inference.
            app.state.pool.demo_devices = {"low": (0,)}
            with TestClient(app) as client:
                self.assertEqual(client.get("/readyz").json()["demo_qualities"], ["low"])
                worker = app.state.pool.workers[0]
                process = worker.process.pid
                for _ in range(2):
                    prepared = finished(client, client.post(
                        "/v1/demo/quality", json={"quality": "low", "devices": [0]},
                    ))
                    self.assertEqual(prepared["state"], "ready", prepared)
                    self.assertIsNone(worker.owner)
                    self.assertEqual(app.state.pool.demo_devices, {"low": (0,)})
                    self.assertEqual(worker.process.pid, process)
                    response = client.post(
                        "/v1/sessions", data={"quality": "low"},
                        files={"portrait": ("portrait.png", portrait(), "image/png")},
                    )
                    self.assertEqual(response.status_code, 201, response.text)
                    session = response.json()
                    self.assertEqual(worker.owner, session["id"])
                    closed = client.delete(
                        "/v1/sessions/" + session["id"],
                        headers={"Authorization": "Bearer " + session["publisher_token"]},
                    )
                    self.assertEqual(closed.status_code, 204)
                    self.assertIsNone(worker.owner)
                self.assertEqual(saved, [([0], "low"), ([0], "low")])


class ReservationCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_configuration_failure_releases_reservation(self):
        with tempfile.TemporaryDirectory() as runtime:
            pool = WorkerPool(Settings(backend="test", runtime_dir=runtime))
            worker = pool.workers[0]
            worker.ready = True
            worker.owner = "quality-switch:failed"
            pool.demo_devices = {}
            with self.assertRaises(WorkerFailure):
                await pool.switch_quality(worker, "low", worker.owner, lambda stage: None)
            self.assertIsNone(worker.owner)
            self.assertIs(await pool.acquire("low", "next-session"), worker)

    async def test_low_only_save_failure_releases_reservation(self):
        with tempfile.TemporaryDirectory() as runtime:
            settings = Settings(backend="test", runtime_dir=runtime)
            settings.save_demo_selection = lambda *args: (_ for _ in ()).throw(OSError("Read-only settings"))
            pool = WorkerPool(settings)
            pool.demo_devices = {"low": (0,)}
            worker = pool.workers[0]
            worker.ready = True
            worker.owner = "quality-switch:failed"
            pool.gpu_options = AsyncMock(return_value=[{"id": 0, "physical_id": 0}])
            with self.assertRaisesRegex(WorkerFailure, "Read-only settings"):
                await pool.switch_quality(worker, "low", worker.owner, lambda stage: None, [0])
            self.assertIsNone(worker.owner)
            self.assertIs(await pool.acquire("low", "next-session"), worker)


if __name__ == "__main__":
    unittest.main()
