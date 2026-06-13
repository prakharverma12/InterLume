import { HW_TIER } from './fsm.js'

export async function detectHardwareTier(onLog) {
  if (!navigator.gpu) {
    onLog?.('[hw] WebGPU unavailable — defaulting to MOBILE')
    return HW_TIER.MOBILE
  }

  let adapter
  try {
    adapter = await navigator.gpu.requestAdapter()
  } catch (e) {
    onLog?.(`[hw] requestAdapter failed: ${e.message} — defaulting to MOBILE`)
    return HW_TIER.MOBILE
  }
  if (!adapter) {
    onLog?.('[hw] No WebGPU adapter found — defaulting to MOBILE')
    return HW_TIER.MOBILE
  }

  const { maxBufferSize } = adapter.limits
  const hasF16 = adapter.features.has('shader-f16')
  const info = adapter.info ?? {}
  onLog?.(`[hw] GPU: ${info.vendor ?? '?'} / ${info.architecture ?? '?'} / ${info.device ?? info.description ?? '?'}`)
  onLog?.(`[hw] maxBufferSize: ${(maxBufferSize / 1024 ** 3).toFixed(2)} GB  |  shader-f16: ${hasF16}`)

  const GB = 1024 ** 3
  const MB = 1024 ** 2

  // If the GPU lacks native FP16 shader support, the fp16 model runs emulated
  // (promoted to fp32 internally), which is slower than int8 on those devices.
  if (!hasF16) {
    onLog?.('[hw] No native shader-f16 — using int8 model regardless of VRAM')
    if (maxBufferSize >= 1 * GB) return HW_TIER.STANDARD  // int8 at higher batch
    if (maxBufferSize >= 512 * MB) return HW_TIER.LOW_END
    return HW_TIER.MOBILE
  }

  if (maxBufferSize >= 2 * GB) return HW_TIER.HIGH_END
  if (maxBufferSize >= 1 * GB) return HW_TIER.STANDARD
  if (maxBufferSize >= 512 * MB) return HW_TIER.LOW_END
  return HW_TIER.MOBILE
}
