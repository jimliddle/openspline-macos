#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
if [ ! -x .venv-macos/bin/python ]; then
  echo "Run sh install-macos.sh first." >&2
  exit 1
fi
export UV_CACHE_DIR="$PWD/.cache/uv"
export PYTHONDONTWRITEBYTECODE=1
if [ ! -x .venv-kokoro/bin/python ]; then
  installed_python=$(uv python find --no-python-downloads 3.12 2>/dev/null || true)
  export UV_PYTHON_INSTALL_DIR="$PWD/.tools/python"
  uv venv --no-project --python "${installed_python:-3.12}" .venv-kokoro
fi
if [ -d .cache/kokoro-uv ] && uv pip install --offline --cache-dir "$PWD/.cache/kokoro-uv" --python .venv-kokoro/bin/python 'kokoro-onnx==0.6.1'; then
  :
else
  uv pip install --python .venv-kokoro/bin/python 'kokoro-onnx==0.6.1'
fi
.venv-kokoro/bin/python packages/server/src/openspline_server/tts.py --prepare
echo "Kokoro is ready. Restart OpenSpline with sh run-macos.sh, then reload the browser page."
