#!/bin/sh
set -eu
if [ "${1:-}" = "--help" ]; then
  echo "Usage: sh install-macos.sh [--no-models]"
  echo "Install the experimental Apple Silicon Lite runtime into .venv-macos."
  exit 0
fi
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--no-models" ]; }; then
  echo "Usage: sh install-macos.sh [--no-models]" >&2
  exit 2
fi
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "This installer requires an Apple Silicon Mac." >&2
  exit 1
fi
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
for tool in uv ffmpeg; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required. Install it with: brew install $tool" >&2
    exit 1
  fi
done
export UV_CACHE_DIR="$PWD/.cache/uv"
export UV_PYTHON_INSTALL_DIR="$PWD/.tools/python"
export OPENSPLINE_DEVICE=mps
export OPENSPLINE_CONFIG="$PWD/workers-macos.yaml"
export PYTORCH_ENABLE_MPS_FALLBACK=1
export PYTHONDONTWRITEBYTECODE=1
export HF_HOME="$PWD/.cache/huggingface"
export TORCH_HOME="$PWD/.cache/torch"
export NUMBA_CACHE_DIR="$PWD/.cache/numba"
if [ ! -x .venv-macos/bin/python ]; then
  uv venv --no-project --python 3.11 .venv-macos
fi
echo "Installing the Metal runtime into $PWD/.venv-macos..."
uv pip install --python .venv-macos/bin/python \
  -e './packages/server[mps]' -e ./packages/python
.venv-macos/bin/python -m openspline_server.hardware --check
.venv-macos/bin/python -m unittest discover -s tests -p test_macos.py -v
if [ "${1:-}" != "--no-models" ]; then
  echo "Downloading the Lite avatar, LTX VAE and audio weights from Hugging Face."
  .venv-macos/bin/python -m openspline_server.cli models --quality low --directory models
fi
sh setup-kokoro.sh
echo "Setup complete. Run: sh run-macos.sh"
