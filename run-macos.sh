#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
if [ ! -x .venv-macos/bin/python ]; then
  echo "Run sh install-macos.sh first." >&2
  exit 1
fi
export OPENSPLINE_DEVICE=mps
export OPENSPLINE_CONFIG="$PWD/workers-macos.yaml"
export OPENSPLINE_RESOLUTION="${OPENSPLINE_RESOLUTION:-512}"
export OPENSPLINE_HOST="${OPENSPLINE_HOST:-127.0.0.1}"
export OPENSPLINE_QUALITY=low
export PYTORCH_ENABLE_MPS_FALLBACK=1
export PYTHONDONTWRITEBYTECODE=1
export NUMBA_CACHE_DIR="$PWD/.cache/numba"
if [ -x "$PWD/.venv-kokoro/bin/python" ]; then
  export OPENSPLINE_TTS_PYTHON="${OPENSPLINE_TTS_PYTHON:-$PWD/.venv-kokoro/bin/python}"
fi
exec .venv-macos/bin/python -m openspline_server.native "$@"
