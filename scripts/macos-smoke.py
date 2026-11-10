"""Generate an actual short avatar video locally, without a server or voice API."""

import argparse
import asyncio
import json
import os
import subprocess
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--portrait", type=Path, default=ROOT / "samples/meera.jpg")
    parser.add_argument("--audio", type=Path, help="Audio file; defaults to macOS system speech")
    parser.add_argument("--blocks", type=int, default=3, help="Number of 24-frame blocks (1 to 10)")
    parser.add_argument("--output", type=Path, default=ROOT / "runtime/macos-smoke")
    args = parser.parse_args()
    if not 1 <= args.blocks <= 10:
        parser.error("--blocks must be between 1 and 10")
    portrait = args.portrait.resolve()
    if not portrait.is_file():
        parser.error(f"Portrait does not exist: {portrait}")
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output.resolve()
    os.chdir(ROOT)
    os.environ.setdefault("OPENSPLINE_DEVICE", "mps")
    os.environ.setdefault("OPENSPLINE_RESOLUTION", "512")
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

    from openspline_server.native import environment

    environment(ROOT)
    import numpy as np
    from openspline_server.quality import prepare_quality
    from openspline_server.config import Settings
    from openspline_server.worker import GPUEngine

    settings = Settings.from_file(ROOT / "workers-macos.yaml")
    asyncio.run(prepare_quality(settings, "low"))
    audio_source = args.audio.resolve() if args.audio else output / "speech.aiff"
    if not args.audio:
        subprocess.run([
            "/usr/bin/say", "-o", str(audio_source),
            "Hello from OpenSpline. This avatar is being generated entirely on this Mac.",
        ], check=True)
    audio = output / "speech.wav"
    if audio_source == audio:
        audio = output / "speech-converted.wav"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(audio_source),
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(audio),
    ], check=True)
    with wave.open(str(audio), "rb") as wav:
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768

    print("Loading the Lite avatar, VAE and audio encoder onto Metal...", flush=True)
    started = time.perf_counter()
    engine = GPUEngine({
        "quality": "low", "model_dir": settings.model_dir,
        "audio_model_dir": settings.audio_model_dir,
    }, 1)
    loaded = time.perf_counter() - started
    started = time.perf_counter()
    engine.prepare(str(portrait), 42)
    prepared = time.perf_counter() - started
    history = np.zeros(engine.cache_samples, dtype=np.float32)
    videos, durations = [], []
    for index in range(args.blocks):
        block = samples[index * engine.chunk_samples : (index + 1) * engine.chunk_samples]
        block = np.pad(block, (0, engine.chunk_samples - len(block)))
        history = np.concatenate((history, block))[-engine.cache_samples:]
        started = time.perf_counter()
        frames = engine.infer(history)
        durations.append(time.perf_counter() - started)
        expected = engine.chunk_samples * engine.fps // 16000
        if frames.ndim != 4 or frames.shape[0] != expected or frames.shape[-1] != 3:
            raise RuntimeError(f"Unexpected frame shape: {frames.shape}")
        videos.append(frames)
        print(f"Block {index + 1}: {len(frames)} frames in {durations[-1]:.2f}s", flush=True)
    video = np.concatenate(videos)
    if not float(video.std()):
        raise RuntimeError("Generated output is blank; refusing to report a successful video")
    temporal_change = float(np.abs(video[1:].astype(np.float32) - video[:-1]).mean())
    destination = output / "avatar.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{video.shape[2]}x{video.shape[1]}",
        "-framerate", str(engine.fps), "-i", "pipe:0", "-i", str(audio),
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", "-movflags", "+faststart", str(destination),
    ], input=video.tobytes(), check=True)
    report = {
        "device": engine.device, "quality": "low", "resolution": list(video.shape[1:3]),
        "frames": len(video), "load_seconds": loaded, "prepare_seconds": prepared,
        "block_seconds": durations, "generated_fps": len(video) / sum(durations),
        "scope": "audio embedding, inference and CPU transfer; excludes playback and encoding",
        "mean_temporal_pixel_change": temporal_change,
        "visual_quality_and_lip_sync_require_review": True, "video": str(destination),
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
