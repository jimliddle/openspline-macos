# OpenSpline for Apple Silicon

**Generate a speaking avatar entirely on your Mac: upload a portrait, crop the face, choose a local voice, and type what it should say.**

This is an Apple Silicon fork of [OpenSpline](https://github.com/openspline/openspline), maintained by [Jim Liddle](https://github.com/jimliddle). It adapts the NVIDIA/CUDA inference path to Apple's Metal GPU through PyTorch MPS and adds local Kokoro text to speech and portrait framing in the web interface.

The local workflow needs no cloud inference account or API key. Initial setup downloads dependencies and models, speech and avatar generation then run locally. Cloud voice integrations inherited from OpenSpline remain separate, optional features.

[openspline-video.webm](https://github.com/user-attachments/assets/94464ac6-1c12-4fab-a366-3864a9b37e99)


## What this fork adds

- **Apple Silicon inference.** A Metal/MPS port of the Low/Lite avatar backend, with device-specific attention, real-valued rotary embeddings, synchronization, validation and memory reporting.
- **Local Kokoro speech.** Type text, choose from 11 English voices, adjust the speed and preview a voice before generating the avatar. Kokoro runs on the CPU in a separate Python environment, leaving Metal available for the face.
- **Portrait zoom and crop.** Frame the face using zoom, dragging, position sliders or arrow keys. Adjust or reset the crop, or return to the full image. The selected crop is used for generation.
- **Uploaded voice audio.** Animate your own speech recording instead of using text to speech. Both sources use the same portrait controls.
- **A Mac setup workflow.** Installation, launch and real video smoke-test scripts, plus speech/video downloads from the browser where recording is supported.

<img width="606" height="384" alt="image" src="https://github.com/user-attachments/assets/b349747b-9048-48d3-a899-57c44a5ad662" />


## Current support

| Area | Status |
| --- | --- |
| Avatar backend | Low/Lite on one Apple GPU through PyTorch MPS |
| Default output | 512 × 512 at 25 FPS playback |
| Local speech | Kokoro ONNX on CPU; American and British English voices |
| Portrait framing | Optional square crop, 1–4× zoom and repositioning |
| Audio input | Typed text or an uploaded speech recording |
| High/Pro and multiple GPUs on Mac | Not supported by this port |
| Hardware validation | M5 Max MacBook Pro, 128 GB unified memory, macOS 26.5 |

Other Apple Silicon models and smaller memory configurations have not yet been validated. The installer checks Metal arithmetic and the 3D convolution used by the model. Working inference does not guarantee good visual quality for every portrait.

## Install and run

On an Apple Silicon Mac, install [Homebrew](https://brew.sh/) if needed, then:

```sh
brew install uv ffmpeg
git clone https://github.com/jimliddle/openspline-macos.git
cd openspline-macos
sh install-macos.sh
sh run-macos.sh
```

Open **http://127.0.0.1:7860** in your browser. Keep the server Terminal open; press **Ctrl+C** there to stop it.

The installer creates `.venv-macos` for the avatar runtime and `.venv-kokoro` for local speech, using Python 3.11 and 3.12 respectively through `uv`. It downloads several gigabytes of models into `models/`. Environments, models, caches and generated files are excluded from Git. A fresh setup needs internet access.

The Mac installer installs the local packages directly with `uv pip`; it does not use the upstream CUDA workspace lock as a Mac dependency lock.

## Make an avatar speak

1. Upload a sharp, front-facing portrait.
2. Choose **Crop portrait**, zoom and drag to make the face fill more of the square, and keep the hair and chin visible. Click **Use this crop**.
3. Select **Typed text · Kokoro (local)**, enter your text, choose a voice and optionally click **Preview voice**.
4. Click **Speak**. Use **Download speech** for the WAV or **Download video** when your browser supports recording the playback.

To use a recording, choose **Upload voice audio** and select a speech file instead. You can listen to it before starting. This mode works independently of Kokoro.

**Adjust crop** reopens the original photo, avoiding repeated resampling. **Cancel** discards draft edits, **Reset** resets the framing, and **Use full image** restores the upload. Speak also applies a crop still visible in the editor. End an active session before changing its portrait.

All cropping happens in the browser. A chosen crop is rendered to a 512 × 512 PNG and sent to the local avatar server.

## Quality and performance

Start with **512 × 512 and a close crop**. A torso portrait leaves fewer pixels for the face. The user confirmed that the cropped workflow works well after seeing teeth and mouth artifacts with the earlier framing.

The Lite model can still distort teeth, expressions or identity on some inputs. Cropping improved the tested example; it is not a universal fix. This fork does not add a new avatar model.

For a lower-resolution diagnostic or a precision comparison, stop the server and run one of these launch commands:

```sh
OPENSPLINE_RESOLUTION=384 sh run-macos.sh
OPENSPLINE_MPS_DTYPE=float32 sh run-macos.sh
```

The default precision is BF16; FP32 uses more memory and may be slower. CPU fallback is enabled for unsupported Metal operations, so some operations may run on the CPU.

An initial 384 × 384 smoke test generated 72 frames. Two warm blocks averaged approximately 44 generated FPS; including the first block, the rate was approximately 15.6 FPS. Loading took 31.8 seconds. These are short engine measurements on the tested M5 Max, not sustained playback benchmarks or 512 × 512 performance claims.

## Verification

Stop the server before the standalone Metal smoke test:

```sh
sh smoke-macos.sh
```

It uses the included upstream sample portrait and macOS system speech, then writes `runtime/macos-smoke/avatar.mp4` and `report.json`. Review the video for appearance and lip sync. Optional inputs:

```sh
sh smoke-macos.sh --portrait /path/to/portrait.jpg --audio /path/to/speech.wav
```

Focused Python checks:

```sh
.venv-macos/bin/python -m unittest discover -s tests -p test_macos.py -v
.venv-macos/bin/python -m unittest discover -s tests -p test_tts.py -v
.venv-macos/bin/python -m unittest discover -s tests -p test_macos_session.py -v
```

With Node.js installed, check the web controls and playback:

```sh
node --test tests/demo-*.test.mjs tests/idle-playback.test.mjs tests/playback-ready.test.mjs tests/playout.test.mjs
```

GPU checks require an actual Metal device. CPU transport tests do not validate generated facial quality. After installation, set `OPENSPLINE_KOKORO_INTEGRATION=1` to include real local Kokoro integration tests.

## Troubleshooting

- **The page is unavailable:** wait for `Application startup complete` and the Uvicorn listening message, then open http://127.0.0.1:7860. Keep the Terminal running.
- **Voice preview is disabled:** wait for the Kokoro status check. For an existing installation, run `sh setup-kokoro.sh`, restart and reload. Speech worker errors are written to `runtime/kokoro-worker.log`.
- **The GPU is busy:** end the existing avatar session. This fork also fixes a Low-only preparation bug that could leave a reservation stuck; restart once if upgrading from that earlier version.
- **Metal is unavailable:** run from a normal macOS Terminal using the installed environment. Restricted sandboxes can prevent GPU discovery.
- **Poor mouth detail:** try a sharper portrait and closer crop. The avatar model generates the mouth and teeth; changing the voice alone does not address facial artifacts.

## Upstream and licensing

Based on OpenSpline revision [`1e5f2b06e6c3dfc68e59ab9bfb3b30997d51caf9`](https://github.com/openspline/openspline/commit/1e5f2b06e6c3dfc68e59ab9bfb3b30997d51caf9). OpenSpline provides the original avatar service, SDKs, browser playback and integrations. The preserved [upstream README](README.upstream.md) describes its NVIDIA, cloud and SDK workflows separately from this Mac setup.

Original copyright and license notices are retained. OpenSpline uses [MIT](LICENSE), with third-party inference terms documented in [the server NOTICE](packages/server/NOTICE) and [vendored Apache-2.0 license](packages/server/src/openspline_server/_vendor/LICENSE). The backend derives from [SoulX-FlashHead](https://github.com/Soul-AILab/SoulX-FlashHead), with Wan and LTX-Video components. Local speech uses [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx).

Model and voice assets are downloaded separately and retain their own terms; they are not bundled here. Python and npm package names inherited from upstream are retained for compatibility. Install this fork from source using the commands above.
