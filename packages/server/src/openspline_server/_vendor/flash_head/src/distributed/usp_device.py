# Modified for the OpenSpline Apple Silicon fork (2026): Metal/MPS support.
import math
from loguru import logger
import datetime
import torch
import torch.distributed as dist

def get_parallel_degree(world_size, num_heads):
    # ulysses_degree is faster, and must be a divisor of num_heads
    ulysses_degree = math.gcd(world_size, num_heads)
    ring_degree = world_size // ulysses_degree
    return ulysses_degree, ring_degree

def get_device(ulysses_degree, ring_degree):
    from openspline_server.device import device_type

    if device_type() == "mps":
        if ulysses_degree != 1 or ring_degree != 1:
            raise ValueError("Metal inference does not support distributed workers")
        return "mps"
    if ulysses_degree > 1 or ring_degree > 1:
        from xfuser.core.distributed import (
            init_distributed_environment,
            initialize_model_parallel,
            get_world_group,
        )

        dist.init_process_group("nccl", timeout=datetime.timedelta(minutes=5))
        init_distributed_environment(rank=dist.get_rank(), world_size=dist.get_world_size())
        initialize_model_parallel(
            sequence_parallel_degree=dist.get_world_size(),
            ring_degree=ring_degree, 
            ulysses_degree=ulysses_degree
        )

        device = torch.device(f"cuda:{get_world_group().rank}")
        torch.cuda.set_device(get_world_group().rank)

        logger.info(f'rank={get_world_group().rank} device={str(device)}')
    else:
        device = "cuda"
    return device

