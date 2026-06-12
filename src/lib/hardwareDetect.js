import { HW_TIER } from './fsm.js'

export async function detectHardwareTier() {
  if (!navigator.gpu) return HW_TIER.MOBILE

  let adapter
  try {
    adapter = await navigator.gpu.requestAdapter()
  } catch {
    return HW_TIER.MOBILE
  }
  if (!adapter) return HW_TIER.MOBILE

  const { maxBufferSize } = adapter.limits
  const GB = 1024 ** 3
  const MB = 1024 ** 2

  if (maxBufferSize >= 2 * GB) return HW_TIER.HIGH_END
  if (maxBufferSize >= 1 * GB) return HW_TIER.STANDARD
  if (maxBufferSize >= 512 * MB) return HW_TIER.LOW_END
  return HW_TIER.MOBILE
}
