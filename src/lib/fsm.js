export const PHASE = Object.freeze({
  IDLE: 'IDLE',
  INITIALIZING: 'INITIALIZING',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
})

export const HW_TIER = Object.freeze({
  MOBILE: 'MOBILE',
  LOW_END: 'LOW_END',
  STANDARD: 'STANDARD',
  HIGH_END: 'HIGH_END',
})

export const BATCH_CONFIG = Object.freeze({
  MOBILE:   { batchSize: 1, modelFile: 'rife_int8.onnx' },
  LOW_END:  { batchSize: 2, modelFile: 'rife_int8.onnx' },
  STANDARD: { batchSize: 4, modelFile: 'rife_fp16.onnx' },
  HIGH_END: { batchSize: 8, modelFile: 'rife_fp16.onnx' },
})

export const HW_TIER_LABELS = Object.freeze({
  MOBILE:   'Mobile / Tablet',
  LOW_END:  'Eco / Low-End',
  STANDARD: 'Standard',
  HIGH_END: 'Pro / High-End',
})
