"""Numerical regression checks; GPU checks require an actual Metal device."""

import os
import unittest
from unittest.mock import patch

try:
    import torch
except ImportError as exc:
    raise unittest.SkipTest("Metal numerical checks require the optional MPS runtime") from exc

from openspline_server.config import Settings, WorkerConfig
from openspline_server.device import device_type, memory_stats, synchronize, validate_mps
from openspline_server._vendor.flash_head.src.modules.flash_head_model import (
    SelfAttention, flash_attention, precompute_freqs_cis_3d, rope_apply, rope_apply_real,
    sinusoidal_embedding_1d,
)


class DeviceTests(unittest.TestCase):
    def test_cuda_remains_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(device_type(), "cuda")

    def test_invalid_device_is_rejected(self):
        with patch.dict(os.environ, OPENSPLINE_DEVICE="invalid"):
            with self.assertRaisesRegex(ValueError, "cuda or mps"):
                device_type()

    def test_metal_sync_does_not_call_cuda(self):
        with patch.object(torch.mps, "synchronize") as mps, patch.object(
            torch.cuda, "synchronize", side_effect=AssertionError("CUDA was used")
        ):
            synchronize("mps")
            mps.assert_called_once_with()

    def test_cuda_sync_keeps_requested_device(self):
        with patch.object(torch.cuda, "synchronize") as cuda:
            synchronize("cuda:1")
            cuda.assert_called_once_with("cuda:1")

    def test_metal_memory_stats_do_not_call_cuda(self):
        with patch.dict(os.environ, OPENSPLINE_DEVICE="mps"), patch.object(
            torch.mps, "driver_allocated_memory", return_value=123
        ), patch.object(torch.mps, "current_allocated_memory", return_value=45), patch.object(
            torch.cuda, "memory_reserved", side_effect=AssertionError("CUDA was used")
        ):
            self.assertEqual(memory_stats(), {
                "gpu_memory_bytes": 123, "gpu_current_allocated_bytes": 45,
            })

    def test_missing_gpu_fails_with_an_actionable_error(self):
        with patch.object(torch.backends.mps, "is_available", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "macOS Terminal"):
                validate_mps()

    def test_metal_rejects_unsupported_allocations(self):
        allocations = [
            [WorkerConfig(devices=(1,))],
            [WorkerConfig(quality="high")],
            [WorkerConfig(quality="high", devices=(0, 1))],
            [WorkerConfig("a"), WorkerConfig("b", devices=(1,))],
        ]
        with patch.dict(os.environ, OPENSPLINE_DEVICE="mps"):
            self.assertEqual(Settings().workers[0].quality, "low")
            for workers in allocations:
                with self.subTest(workers=workers), self.assertRaises(ValueError):
                    Settings(workers=workers)

    def test_metal_does_not_initialize_distributed_cuda(self):
        from openspline_server._vendor.flash_head.src.distributed.usp_device import get_device

        with patch.dict(os.environ, OPENSPLINE_DEVICE="mps"), patch(
            "torch.distributed.init_process_group", side_effect=AssertionError("NCCL was used")
        ):
            self.assertEqual(get_device(1, 1), "mps")
            with self.assertRaisesRegex(ValueError, "distributed"):
                get_device(2, 1)


class RotaryTests(unittest.TestCase):
    def test_invalid_model_pixels_are_rejected(self):
        from openspline_server.worker import GPUEngine, WorkerFailure

        for value in (float("nan"), float("inf")):
            with self.subTest(value=value), self.assertRaisesRegex(WorkerFailure, "non-finite"):
                GPUEngine._frames_to_numpy(torch.tensor([value]))

    def test_valid_model_pixels_are_converted(self):
        from openspline_server.worker import GPUEngine

        pixels = GPUEngine._frames_to_numpy(torch.tensor([0., 127., 255.]))
        self.assertEqual(pixels.dtype.name, "uint8")
        self.assertEqual(pixels.tolist(), [0, 127, 255])

    def test_real_rotations_match_complex_reference(self):
        generator = torch.Generator().manual_seed(123)
        for head_dim in (12, 24, 128):
            freqs = precompute_freqs_cis_3d(head_dim)
            for shape in ((1, 2, 3), (2, 3, 4), (3, 4, 5)):
                for dtype in (torch.float32, torch.float16, torch.bfloat16):
                    with self.subTest(head_dim=head_dim, shape=shape, dtype=dtype):
                        size = shape[0] * shape[1] * shape[2]
                        x = torch.randn((1, size, 2, head_dim), generator=generator).to(dtype)
                        expected = rope_apply(x, freqs, shape)
                        actual = rope_apply_real(x, torch.view_as_real(freqs).float(), shape)
                        tolerance = 1e-5 if dtype == torch.float32 else 0.02
                        torch.testing.assert_close(actual, expected, atol=tolerance, rtol=tolerance)

    def test_rotations_preserve_padding(self):
        x = torch.randn(2, 30, 2, 12)
        freqs = torch.view_as_real(precompute_freqs_cis_3d(12)).float()
        actual = rope_apply_real(x, freqs, (2, 3, 4))
        self.assertEqual(actual.shape, x.shape)
        torch.testing.assert_close(actual[:, 24:], x[:, 24:], atol=0, rtol=0)

    def test_attention_matches_original_path(self):
        torch.manual_seed(456)
        freqs = precompute_freqs_cis_3d(12)
        attention = SelfAttention(24, 2).eval()
        x = torch.randn(1, 24, 24)
        with torch.inference_mode():
            expected = attention(x, freqs, (2, 3, 4))
            actual = attention(x, torch.view_as_real(freqs).float(), (2, 3, 4))
        torch.testing.assert_close(actual, expected, atol=1e-5, rtol=1e-5)

    def test_non_cuda_attention_uses_pytorch(self):
        import openspline_server._vendor.flash_head.src.modules.flash_head_model as model

        q = torch.randn(1, 6, 24, dtype=torch.bfloat16)
        with patch.object(model, "SAGE_ATTN_AVAILABLE", True), patch.object(
            model, "sageattn", create=True, side_effect=AssertionError("CUDA kernel was used")
        ):
            result = flash_attention(q, q, q, 2)
        self.assertTrue(torch.isfinite(result).all())


@unittest.skipUnless(torch.backends.mps.is_available(), "Metal GPU unavailable to this process")
class MetalIntegrationTests(unittest.TestCase):
    def test_metal_arithmetic_and_conv3d(self):
        expected = getattr(torch, os.getenv("OPENSPLINE_MPS_DTYPE", "bfloat16"))
        self.assertEqual(validate_mps(), expected)

    def test_metal_attention_and_embeddings(self):
        torch.manual_seed(456)
        attention = SelfAttention(24, 2).eval()
        freqs = precompute_freqs_cis_3d(12)
        x = torch.randn(1, 24, 24)
        with torch.inference_mode():
            expected = attention(x, freqs, (2, 3, 4))
            actual = attention.to("mps")(
                x.to("mps"), torch.view_as_real(freqs).float().to("mps"), (2, 3, 4)
            ).cpu()
            torch.testing.assert_close(actual, expected, atol=2e-4, rtol=2e-4)
            position = torch.tensor([0., 250., 750., 1000.])
            expected = sinusoidal_embedding_1d(256, position)
            actual = sinusoidal_embedding_1d(256, position.to("mps")).cpu()
            torch.testing.assert_close(actual, expected, atol=1e-4, rtol=1e-4)


if __name__ == "__main__":
    unittest.main()
