#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
if [ ! -x .venv-macos/bin/python ]; then
  echo "Run sh install-macos.sh first." >&2
  exit 1
fi
export OPENSPLINE_DEVICE=mps
export OPENSPLINE_RESOLUTION="${OPENSPLINE_RESOLUTION:-512}"
export PYTORCH_ENABLE_MPS_FALLBACK=1
export PYTHONDONTWRITEBYTECODE=1
exec .venv-macos/bin/python scripts/macos-smoke.py "$@"
