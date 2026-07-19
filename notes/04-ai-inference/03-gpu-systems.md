---
title: GPU execution and memory
shortTitle: GPU systems
description: Trace the deployable GPU stack, then read performance and failure as interactions among software compatibility, arithmetic, memory movement, launch overhead, and topology.
collection: ai-inference
slug: gpu-systems
order: 3
number: AI3
duration: 165 min
difficulty: Core
tags:
  - CUDA
  - HBM
  - SIMT
  - Roofline
  - drivers
  - DCGM
---

## Working model

A CPU runs the service and asks a GPU to perform large groups of tensor operations. The GPU can finish those operations quickly only when it has enough parallel work and can move operands through memory fast enough. Arithmetic, data movement, launch overhead, and device links form one path; the slowest saturated part sets the ceiling.

## Questions this note answers

- Explain why inference uses a CPU and GPU together
- Trace a containerized serving process through framework, CUDA libraries, user-mode driver, kernel driver, and device injection
- Match driver, runtime, library, architecture, and container mismatches to their failure signatures
- Relate device programs, threads, warps, blocks, and streaming multiprocessors
- Place registers, shared memory, caches, device DRAM, and host memory in the access hierarchy
- Explain what Tensor Cores accelerate and why a headline rate does not apply to every operation
- Use arithmetic intensity to identify a compute or bandwidth ceiling
- Explain what streams, PCIe, NVLink, and RDMA change in a serving path
- Choose request traces, Nsight Systems, Nsight Compute, or DCGM for the question being asked

## A GPU is an accelerator, not the whole server

A CPU favors fast execution of a small number of varied instruction streams. It runs the operating system, network server, request validation, much of tokenization, scheduling logic, and storage access. A GPU trades single-thread responsiveness for many arithmetic lanes and high memory bandwidth, which suits the repeated matrix operations in neural-network layers.

CUDA is NVIDIA's programming model and software stack for asking a supported GPU to do work. CUDA calls originate in **host** code on the CPU. The CPU copies or exposes data to **device** memory, launches a device function called a **kernel**, and later waits for or consumes the result. Frameworks and serving engines issue these calls, so an infrastructure engineer rarely writes each kernel but still needs to recognize where time and memory go.

A GPU does not make every operation faster. Tiny tensor shapes, CPU preprocessing, many small launches, or repeated transfers can cost more than the device arithmetic saves. End-to-end traces must include both processors.

## Trace the deployable software stack before tuning a kernel

A model container does not contain a complete GPU. The host owns the hardware and kernel driver; the container carries most application libraries; the container runtime connects those worlds when it creates the process. A failure at any lower layer can make a correct serving engine look broken.

Read the steady execution path from the request down to the device:

```text
API and serving engine
  -> framework and compiled extensions
    -> CUDA math/communication libraries and CUDA Runtime API
      -> CUDA user-mode driver library
        -> device files and operating-system calls
          -> host NVIDIA kernel-mode driver
            -> GPU hardware

container runtime + NVIDIA Container Toolkit or CDI
  -> exposes the assigned device nodes and required host driver libraries
     inside the container before the serving process starts
```

The container-runtime arrow is setup, not a hop on every kernel launch. In Kubernetes, resource assignment says which GPU a workload may receive; the OCI runtime, NVIDIA Container Toolkit, or Container Device Interface (CDI) path must still make the assigned device and driver-side libraries visible inside the container.

| Layer                                  | What it owns                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host kernel-mode driver                | Discovers and initializes the GPU, manages low-level memory and execution resources, handles interrupts and faults, and exposes device interfaces to user processes. It must match the running host kernel and support the installed hardware.                                                                                                                                                                                 |
| User-mode driver boundary              | The CUDA Driver API library, commonly `libcuda.so` on Linux, turns process calls into work understood by the kernel driver. NVML is a separate user-mode management interface used for inventory and telemetry rather than tensor execution.                                                                                                                                                                                   |
| CUDA runtime, toolkit, and libraries   | The CUDA Runtime API, commonly `libcudart`, provides a higher-level programming interface over the driver. Toolkit packages also contain build tools and headers; a production image needs its linked runtime components, not necessarily the compiler. Libraries such as cuBLAS or cuBLASLt perform dense linear algebra, cuDNN supplies neural-network operations, and NCCL implements multi-GPU communication.              |
| Framework                              | PyTorch, JAX, or another framework chooses operators, manages tensors and autograd-related abstractions, loads compiled extensions, and dispatches work into CUDA libraries or custom kernels. Inference can disable gradient state, but it still depends on the framework's binary and operator compatibility.                                                                                                                |
| Serving engine                         | The engine loads the model bundle, owns request scheduling and cache allocation, chooses framework or custom execution paths, and exposes or feeds a protocol server. It cannot repair a missing driver library or unsupported kernel binary.                                                                                                                                                                                  |
| Container runtime and device injection | The runtime creates the isolated process. NVIDIA Container Toolkit hooks or CDI descriptions add the assigned GPU device nodes, mounts, and host driver capabilities. The image normally carries the chosen CUDA runtime and math or communication libraries, framework, engine, and model code; the injected driver-side library still corresponds to the host driver, and the image does not replace the host kernel driver. |

### Use the failure signature to find the broken contract

CUDA compatibility is not “container version must equal driver version.” NVIDIA documents backward, minor-version, and forward-compatibility paths with specific platform and feature limits. In particular, a runtime feature or PTX just-in-time compilation path may still require a newer driver even when other applications in the same CUDA major family run. Check the live compatibility guide and the exact library release notes instead of memorizing one version table.

| Broken boundary                                             | Typical evidence                                                                                                                                                                    | First check                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardware or running kernel ↔ kernel driver                  | The host has no usable device; the kernel module fails to load; `nvidia-smi` cannot communicate with the driver.                                                                    | Host kernel log, loaded modules, device PCI identity, driver support matrix, and host security or module-signing policy. A container rebuild cannot fix this layer.                                                                             |
| Kernel-mode ↔ user-mode driver libraries                    | NVML reports a driver/library version mismatch, or CUDA fails during initialization even though the device exists.                                                                  | Compare the running kernel module with the user-mode libraries actually loaded by the process; remove stale library paths and complete the driver rollout or reboot required by that rollout.                                                   |
| CUDA application/runtime ↔ installed driver                 | Initialization returns an insufficient-driver error; a newer call reports that it requires a newer driver; PTX JIT compilation fails on an older driver.                            | Exact CUDA runtime and application build, driver version, compatibility mode, use of PTX, and whether the requested feature is covered by the documented compatibility path.                                                                    |
| Compiled kernel ↔ GPU compute capability                    | Startup succeeds, but the first affected operator reports that no compatible kernel image is available or that the architecture is unsupported.                                     | Architectures embedded in the binary or extension, any PTX fallback, GPU compute capability, and whether the driver can JIT that PTX. Rebuild for the target instead of changing request limits.                                                |
| CUDA/cuDNN/cuBLAS/NCCL library set ↔ framework or extension | Import or startup reports a missing shared object or undefined symbol; one operator has no supported implementation; a distributed group fails while single-device execution works. | Dynamic-library resolution inside the container, framework build metadata, library dependency matrix, engine plugins, and the exact NCCL plus fabric configuration. Do not assume every library in a CUDA-labeled image is mutually compatible. |
| Scheduler assignment ↔ container injection                  | The host can use the GPU, but the container sees no device, the wrong device, missing `libcuda`, or permission errors.                                                              | Assigned GPU UUID, CDI or runtime configuration, injected device nodes and mounts, container environment, runtime class, and a minimal device query inside the same image.                                                                      |
| Framework ↔ serving engine or model extension               | CUDA initializes, but the engine fails while importing an extension, loading the bundle, compiling a graph, or executing the first model-specific operation.                        | Pin framework and engine builds, extension ABI, model architecture, dtype and quantization kernels, tokenizer/config identity, and effective engine flags.                                                                                      |

Test one boundary at a time. A successful `nvidia-smi` proves that a management client can talk to the host driver; it does not prove that the container sees the assigned device, that the application's runtime is compatible, or that the model has a kernel for the GPU. Conversely, a model OOM after several healthy requests is usually an allocation or workload problem, not evidence that the driver installation failed.

## Map the CUDA words to one launch

| Term                          | What it means                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel                        | A function launched on the GPU over many work items. Matrix multiplication, normalization, and token sampling may use separate kernels or fused kernels.                                                                                                                                                         |
| Thread                        | One logical execution lane for a kernel. It handles a small part of the input using its indices.                                                                                                                                                                                                                 |
| Warp                          | The hardware scheduling group for threads; current NVIDIA CUDA devices group 32 threads. Divergent branches can leave some lanes inactive.                                                                                                                                                                       |
| Block and grid                | A block groups threads that can share on-chip storage and synchronize. All blocks launched for one kernel form a grid.                                                                                                                                                                                           |
| Streaming multiprocessor (SM) | A GPU execution unit that schedules resident warps and provides registers, shared memory, caches, and arithmetic units.                                                                                                                                                                                          |
| Device DRAM and host memory   | Device DRAM, also called global or device memory in CUDA and often called VRAM operationally, is attached to the GPU. It may use HBM or another technology such as GDDR; not every GPU uses HBM. Host memory is attached to the CPU, and moving between the two normally crosses PCIe or another supported link. |

Suppose a matrix operation has millions of independent multiply-and-add results. The runtime launches a grid, blocks land on available SMs, and warps issue instructions. Each thread calculates part of the result while the memory system feeds operands. A shortage of arithmetic units, device-memory bandwidth, resident warps, or work ready to launch can become the limit.

## Kernels launch grids of cooperating threads

CUDA groups threads into blocks, and hardware executes groups of threads called warps on streaming multiprocessors. Threads in one block can coordinate through shared memory and barriers; blocks must remain independently schedulable unless a newer cooperative mechanism states otherwise.

Branch divergence makes threads in one warp follow different control paths serially. **Occupancy** compares resident warps on an SM with the hardware maximum. Low occupancy can leave execution units without another ready warp, but maximum occupancy is not the service goal either. Register use, shared-memory use, instruction mix, and available parallel work decide whether another resident warp helps.

## Tensor Cores accelerate eligible matrix tiles

**Tensor Cores** are specialized matrix multiply-accumulate datapaths inside supported NVIDIA GPU SMs. They calculate many products and accumulations over small matrix tiles, using particular input, output, accumulator, shape, layout, and alignment combinations. Libraries and compiled kernels map a larger tensor operation onto those tile instructions when the hardware and operation are eligible.

They are not a faster mode for every CUDA instruction. Tokenization on the CPU, elementwise kernels, an unsupported dtype, a tiny or badly aligned matrix, data conversion, communication, and memory stalls can all avoid or underfeed the Tensor Core path. A published Tensor Core rate is therefore a hardware ceiling under its stated dtype and counting convention, not the rate of an arbitrary model request. Confirm that the selected kernels actually issue matrix-multiply-accumulate instructions and then measure achieved useful work.

## Device-memory bandwidth often matters more than peak FLOPS

Registers hold per-thread values on an SM. Shared memory is a programmer-managed on-chip area shared within a block, and caches retain recently accessed data when the access pattern allows reuse. The GPU's attached off-chip DRAM supplies far more capacity but sits farther from the arithmetic units. Some data-center accelerators implement that device DRAM with HBM; other GPUs use GDDR. HBM is therefore one device-memory technology, not a synonym for every GPU's memory. Model weights and KV data that stream from device memory during each step can make decode bandwidth-bound even on a GPU with abundant arithmetic throughput.

Arithmetic intensity counts operations per byte moved. A simple Roofline bound takes the smaller of peak compute and memory bandwidth multiplied by arithmetic intensity. It is a ceiling, not a prediction; kernel shape, occupancy, cache behavior, synchronization, and software overhead can lower achieved performance.

A floating-point operation, abbreviated FLOP, is one numeric operation under the counting convention used by the test; a multiply-add is often counted as two. FLOP/s is an arithmetic rate. Bytes/s is a memory-transfer rate. Arithmetic intensity, FLOPs divided by bytes moved, connects the units so the Roofline model can compare the two ceilings.

_Keep units consistent. The result only identifies a possible bottleneck._

```text
attainable compute <= min(peak FLOP/s, memory bandwidth x FLOP/byte)
```

## Storage dtype and compute dtype are separate choices

A checkpoint label does not fully describe execution. Weights may be stored in one format, converted or dequantized while loading, multiplied in another format, and accumulated at higher precision. Tensor Core peak rates also assume supported dtypes, matrix shapes, alignment, and instruction paths; a GPU's FP8 or FP4 headline does not apply to an arbitrary FP16 kernel.

Record stored weight format, activation format, KV-cache format, multiplication dtype, accumulator dtype, and the selected kernel. For a quantized model, include group size and scale metadata. This prevents a misleading comparison in which two deployments both say “4-bit” but execute different kernels or keep different tensors at higher precision. [Single-node optimization](05-single-node-optimization.md#quantization-has-more-than-one-axis) covers the serving trade.

## The host and neighboring GPUs remain part of the system

CUDA streams order operations and let independent transfers and kernels overlap when dependencies and hardware permit it. Pinned host buffers occupy physical memory that the operating system will not page away, which lets supported direct-memory transfer paths avoid an extra staging copy. Fewer small launches reduce host-device overhead; CUDA graphs can replay a stable launch graph with less CPU submission work.

PCIe connects CPUs and devices broadly. NVLink supplies higher-bandwidth GPU links on supported systems, and GPUDirect remote direct memory access (RDMA) lets a capable network adapter exchange GPU memory with less CPU staging. On a non-uniform memory access (NUMA) host, a CPU reaches its local memory and PCIe devices through a different path than resources attached to another CPU socket. None of those names prove the route a particular transfer takes. Inspect the machine topology.

## Clocks move when power or temperature limits intervene

A GPU's clock rate is not fixed at the advertised maximum. Firmware and the driver can lower clocks when the board reaches a configured power limit, approaches a thermal threshold, idles, or encounters another clock-limiting condition. That change can lengthen every kernel and make one rank slow enough to hold a distributed group.

Record board power, SM and memory clocks, temperature, and clock-event reasons beside the request trace. A power cap can reduce peak watts and sometimes improve energy per useful token, but it can also violate latency targets; only a controlled workload comparison answers that trade. [Performance and SRE](08-inference-performance-and-sre.md#measure-power-energy-and-useful-work-separately) defines watts, joules, full-system measurement, and energy per request.

> **Profile the real shape.** A kernel can look compute-heavy in source and still stall on memory or launch overhead. Use hardware counters and an end-to-end trace before rewriting it.

## Triage allocator failures, device faults, and rank loss separately

An application error, a recoverable device event, and a node-level hardware fault require different blast radii. Preserve the first error, GPU UUID, PCI bus identity, driver and container build, kernel-log window, affected request and rank IDs, and DCGM history before restarting components. An Xid is a driver-reported diagnostic starting point; NVIDIA's catalog explicitly distinguishes actions such as restart application, reset GPU, or reboot, and the same numeric-looking symptom must not be mapped to one universal action.

| Observation                     | What it means and what to inspect                                                                                                                                                                                                                                                                                                                                                                                                                         | Operator response                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allocator fragmentation or OOM  | The application cannot satisfy an allocation. Actual live tensors may fill memory, or an allocator may have enough bytes in aggregate but not in a reusable shape or pool. Compare request token or tensor shape, engine KV blocks, framework allocated versus reserved bytes, CUDA memory-pool current and high-water marks, other processes, and the failed allocation size. DCGM's device-wide used-memory value cannot identify the owning allocator. | Stop admitting work that cannot fit, let cancellation and cleanup release state, and preserve the triggering shape. Lower batch, context, cache, or pool watermarks only from a measured model. Drain and restart the process if its allocator cannot recover; a GPU reset is normally not the fix for an ordinary application OOM. |
| ECC report                      | ECC can be corrected or uncorrectable and can affect device DRAM or on-chip structures. Inspect volatile and aggregate counts, affected location, row-remap or page-retirement state, associated Xids, DCGM health, and recurrence. Do not erase counters before collecting evidence.                                                                                                                                                                     | Follow the current DCGM and Xid recovery classification. A corrected event may be monitored under fleet policy; uncorrectable, pending-retirement, remap-failure, or uncontained events can require cordon, drain, diagnostics, reset, or reboot depending on architecture and reported recovery action.                            |
| Xid or device fault             | The kernel driver logged a GPU error that may originate in an application, driver, firmware, fabric, PCIe path, or hardware. The Xid value is evidence, not a complete root cause. Correlate the first Xid with GPU UUID, the failing process and rank, DCGM fields, fabric errors, and the official catalog.                                                                                                                                             | Remove the affected device or serving group from admission, preserve logs, and perform the catalog's immediate action. Escalate recurring faults through the documented diagnostic path rather than repeatedly resetting the node and losing evidence.                                                                              |
| GPU reset required or attempted | Reset is a recovery operation, not a diagnosis. It clears device and application state, and it generally requires processes using the device to exit. Peer-linked devices or fabric management can expand the coordination scope.                                                                                                                                                                                                                         | Cordon and drain first, terminate or confirm exit of every device user, follow the reported recovery action and platform reset limitations, then run health checks and a known workload before returning capacity. If the action says reboot, do not claim an in-place reset restored the host.                                     |
| Failed distributed rank         | One process or GPU has left a collective while peers wait. Evidence includes rank heartbeat and process exit, collective timeout, NCCL logs, Xid and link telemetry, and the last request or batch assigned to the group. Healthy-looking peer devices do not make the logical replica healthy.                                                                                                                                                           | Fail and replace the whole serving group, cancel its in-flight collectives, and retry only idempotent requests under a retry budget. Re-form all ranks from a known bundle and topology; do not leave surviving ranks blocked while routing new traffic to them.                                                                    |

Health automation should encode the current severity and recovery action rather than a hand-maintained list of “bad Xids.” DCGM diagnostics can be invasive and require exclusive access, so run the appropriate level after draining and record its exact version and result.

## Use units to test a bottleneck hypothesis

Assume a kernel performs 60 trillion floating-point operations and moves 6 trillion bytes from device DRAM for one reference workload. Its arithmetic intensity is 10 FLOPs per byte. On a device with a 90 TFLOP/s arithmetic roof and 4 TB/s of device-memory bandwidth, the bandwidth roof is 40 TFLOP/s. The smaller roof is 40 TFLOP/s, so this simplified model predicts a bandwidth limit.

The calculation does not say the kernel will achieve 40 TFLOP/s. It may reach much less because memory accesses are not fully coalesced, cache reuse differs from the byte estimate, launches leave gaps, or thread blocks use too many registers to keep enough warps resident. The value of the calculation is narrower: it tells the profiler which ceiling to test first and prevents an impossible target such as 80 TFLOP/s under the stated byte traffic.

_Tera units cancel only because the operation and byte scales match._

```text
intensity = 60 TFLOP / 6 TB = 10 FLOP/byte
bandwidth roof = 4 TB/s x 10 FLOP/byte = 40 TFLOP/s
roofline bound = min(90, 40) = 40 TFLOP/s
```

## A warp follows one instruction stream at a time

On current NVIDIA CUDA devices, a warp contains 32 threads. When threads in a warp take different sides of a data-dependent branch, the hardware executes the required paths while disabling threads that are not on the active path. The result is correct, but fewer lanes do useful work during each path. Divergence between different warps is not the same problem because warps already have independent instruction state.

Memory addresses matter at the same scale. Neighboring threads that access neighboring words can be served with fewer memory transactions than scattered addresses. Shared memory can stage reused data, but its banks can conflict when several threads address the same bank in an incompatible pattern. A change that removes a branch but creates scattered device-memory traffic may still lose, so source-code simplicity is not a hardware measurement.

- Check achieved occupancy together with register and shared-memory use.
- Inspect memory throughput, transaction efficiency, and cache behavior.
- Compare kernel duration and launch gaps on the same input shape.

## Profile from the request down to the kernel

Choose the narrowest observation layer that can answer the question. Profilers can add overhead or replay work, so a profile is an experiment tied to its tool version and collection settings, not ordinary production latency.

| Evidence                         | Use it when asking                                                                                                                                                                                                                                  | It cannot answer alone                                                                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request trace and engine metrics | Which tenant, model, prompt shape, queue phase, batch, adapter, cache state, collective, cancellation, or delivery interval made this request slow or fail? Start here because it preserves the product and scheduler boundary.                     | Why one kernel stalled on a particular instruction or memory path; whether a device has fleet-wide recurring ECC or link faults.                                                                                       |
| Nsight Systems                   | Where did time go across CPU threads, CUDA API calls, memory copies, streams, kernel launches, synchronization, NVTX ranges, and possibly several processes? Use its system-wide timeline for launch gaps, failed overlap, or a slow rank interval. | Detailed per-kernel instruction, cache, warp-stall, or source-line efficiency. It shows when a kernel ran more readily than why its instructions underperformed.                                                       |
| Nsight Compute                   | Why does one selected CUDA kernel underperform for this exact launch shape? Use its kernel metrics, roofline views, memory analysis, occupancy, instruction and source correlation after the timeline identifies the kernel.                        | End-to-end request, queue, or distributed service behavior. Metric collection can replay kernels and change timing, so do not substitute its profiled duration for user latency without understanding collection mode. |
| DCGM                             | Is the fleet or device healthy over time, and were clocks, power, temperature, device memory, utilization, ECC, Xid, PCIe, NVLink, or recovery indicators abnormal? Join by GPU identity and time to the request or rank.                           | Which request owned memory, which framework allocator fragmented, or which source line made a kernel slow. Device-wide utilization is not request attribution.                                                         |

Begin with a request trace so the slow interval has a phase and a batch shape. A long queue wait is not a GPU kernel fault. A slow prefill may point to long prompts, compute, or a scheduling collision; a slow decode may point to weight and KV reads, small batches, collectives, or launch gaps. Preserve model, dtype, input dimensions, concurrency, and clock conditions when comparing two traces.

Next inspect the device timeline. Look for copies that fail to overlap, long CPU gaps before launches, synchronization that drains all streams, and one kernel that dominates the active interval. Hardware counters can then test whether that kernel is limited by arithmetic issue rate, device-memory traffic, cache misses, dependencies, or occupancy. Change one factor and rerun the same case. A device-wide utilization percentage cannot provide this causal chain by itself.

> **Common false lead.** Adding streams does not create overlap when operations depend on each other, the device is already saturated, or transfers use pageable memory and unsupported paths.

## Summary

GPU service behavior is constrained by the slowest valid part of a hierarchy that includes software compatibility, kernels, on-chip storage, device DRAM, host submission, PCIe, and peer links. Start with the deployable stack, request phase, and real tensor shape, then use the appropriate trace or profiler to test whether compatibility, compute, bandwidth, launch overhead, divergence, communication, or a device fault is responsible.

- **Prove the deployed stack bottom-up.** The host kernel driver owns the device; injected user-mode driver libraries cross into the container; CUDA runtime and libraries feed the framework; the serving engine schedules the model. A working host query does not prove that every higher boundary works.
- **Keep the CPU in the design.** It owns the operating system, request path, scheduling, storage, and kernel submission while the GPU accelerates suitable tensor work. Small launches and transfers can erase a device win.
- **Define Tensor Cores before using their rate.** They accelerate eligible matrix multiply-accumulate tiles under supported dtype, shape, layout, and accumulation rules. They do not accelerate every operation, and their hardware ceiling is not request throughput.
- **Reason in blocks, warps, and SMs.** Threads in a block can share memory and synchronize; blocks normally schedule independently. NVIDIA warps contain 32 threads, so branch divergence leaves lanes inactive on each path.
- **Use arithmetic intensity to test a memory-bound claim.** Intensity is FLOPs divided by bytes moved. At 10 FLOPs/byte, 4 TB/s of device-memory bandwidth implies a 40 TFLOP/s bandwidth roof; on a 90 TFLOP/s device, the lower roof predicts a bandwidth limit.
- **Treat device DRAM and KV traffic as real work.** Decode can repeatedly stream weights and cache data with too little arithmetic per byte to reach peak FLOPS. HBM and GDDR are device-memory technologies; not every GPU has HBM. Registers, shared memory, and caches help only when the kernel creates reuse.
- **Name storage, multiplication, and accumulation formats.** A model stored at 4 bits may run a wider compute path, while Tensor Core rates depend on dtype, shape, alignment, and hardware. The checkpoint label cannot predict speed.
- **Include topology, clocks, and limits.** PCIe, NVLink-class paths, NIC and NUMA placement affect movement; power or thermal limiting changes clocks. Streams and CUDA graphs help only when dependencies and resources allow overlap.
- **Keep allocator, device, and group failures separate.** An application OOM does not normally require a GPU reset; an Xid is a diagnostic clue rather than one recovery command; one dead rank invalidates its logical serving group. Preserve evidence and follow the current recovery classification.
- **Profile from request to kernel and fleet.** Request traces supply workload context, Nsight Systems supplies the CPU/GPU timeline, Nsight Compute supplies selected-kernel counters, and DCGM supplies fleet health and device telemetry. Compare runs with model, dtype, shapes, batch, clocks, power settings, and concurrency recorded.

## References

Version-sensitive compatibility, container, profiler, and recovery documentation was reviewed on 18 July 2026. Recheck the live pages for the exact deployed releases.

- [NVIDIA: CUDA Programming Guide](https://docs.nvidia.com/cuda/cuda-programming-guide/index.html)
- [NVIDIA: GPU memory in the CUDA programming model](https://docs.nvidia.com/cuda/cuda-programming-guide/01-introduction/programming-model.html#gpu-memory)
- [NVIDIA: CUDA tile kernels and matrix multiply-accumulate](https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/writing-tile-kernels.html)
- [NVIDIA: CUDA C++ Best Practices Guide](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html)
- [NVIDIA: CUDA compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/latest/index.html)
- [NVIDIA: CUDA stream-ordered memory allocator](https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__MEMORY__POOLS.html)
- [NVIDIA Container Toolkit: architecture overview](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/arch-overview.html)
- [NVIDIA Container Toolkit: CDI support](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html)
- [NVIDIA: GPUDirect RDMA](https://docs.nvidia.com/cuda/gpudirect-rdma/)
- [NVIDIA Nsight Systems: user guide](https://docs.nvidia.com/nsight-systems/UserGuide/index.html)
- [NVIDIA Nsight Compute: user guide](https://docs.nvidia.com/nsight-compute/NsightCompute/)
- [NVIDIA: Xid errors](https://docs.nvidia.com/deploy/xid-errors/index.html)
- [NVIDIA: GPU debug guidelines](https://docs.nvidia.com/deploy/gpu-debug-guidelines/index.html)
- [NVIDIA DCGM: feature overview and health checks](https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/feature-overview.html)
- [NVIDIA DCGM: diagnostic error categories and recovery severities](https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/diag-errors.html)
- [NVIDIA DCGM: field identifiers](https://docs.nvidia.com/datacenter/dcgm/latest/dcgm-api/dcgm-api-field-ids.html)
