"""Device operations shared by the CUDA service and experimental Metal port."""

import os


def device_type():
    value = os.getenv("OPENSPLINE_DEVICE", "cuda")
    if value not in {"cuda", "mps"}:
        raise ValueError("OPENSPLINE_DEVICE must be cuda or mps")
    return value


def synchronize(device):
    import torch

    kind = torch.device(device).type
    if kind == "cuda":
        torch.cuda.synchronize(device)
    elif kind == "mps":
        torch.mps.synchronize()


def validate_mps():
    import torch

    if not torch.backends.mps.is_available():
        raise RuntimeError(
            "Apple Metal (MPS) is unavailable to this Python process. "
            "Use the macOS environment from install-macos.sh and run it in macOS Terminal. "
            "A restricted sandbox can also prevent GPU discovery."
        )
    precision = os.getenv("OPENSPLINE_MPS_DTYPE", "bfloat16")
    if precision not in {"bfloat16", "float32"}:
        raise ValueError("OPENSPLINE_MPS_DTYPE must be bfloat16 or float32")
    dtype = getattr(torch, precision)
    # Check both arithmetic and the 3D convolution used by the avatar and VAE.
    with torch.inference_mode():
        matrix = torch.ones((8, 8), device="mps", dtype=dtype)
        product = matrix @ matrix
        volume = torch.ones((1, 1, 3, 4, 4), device="mps", dtype=dtype)
        kernel = torch.ones((1, 1, 1, 3, 3), device="mps", dtype=dtype)
        convolved = torch.nn.functional.conv3d(volume, kernel)
        synchronize("mps")
        if product[0, 0].item() != 8 or not torch.all(convolved == 9).item():
            raise RuntimeError("Metal arithmetic or Conv3d returned an incorrect result")
    return dtype


def memory_stats():
    import torch

    if device_type() == "mps":
        return {
            "gpu_memory_bytes": torch.mps.driver_allocated_memory(),
            "gpu_current_allocated_bytes": torch.mps.current_allocated_memory(),
        }
    return {
        "gpu_memory_bytes": torch.cuda.memory_reserved(),
        "gpu_peak_allocated_bytes": torch.cuda.max_memory_allocated(),
    }
