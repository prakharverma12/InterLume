import * as ort from 'onnxruntime-web/webgpu'

ort.env.wasm.wasmPaths = '/onnx-wasm/'

export async function createSession(modelBuffer, onLog) {
  onLog('Creating ONNX inference session...')

  let session
  try {
    session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: [
        { name: 'webgpu', preferredLayout: 'NCHW' },
        'wasm',
      ],
      graphOptimizationLevel: 'all',
      enableCpuMemArena: false,
    })
  } catch (e) {
    throw new Error(
      `no available backend found. ERR: ${e.message} — ensure COOP/COEP headers are set and WASM files are reachable at /onnx-wasm/`
    )
  }

  onLog(`Model loaded. Inputs: ${session.inputNames.join(', ')}`)
  onLog('Running warm-up inference...')

  // Pre-compile WGSL shaders — prevents 300-800ms stall on first real batch
  const H = 64, W = 64
  const dummyData = new Float32Array(3 * H * W)
  const dummy = new ort.Tensor('float32', dummyData, [1, 3, H, W])
  const tStep = new ort.Tensor('float32', new Float32Array([0.5]), [1])

  const inputMap = buildInputMap(session.inputNames, dummy, dummy, tStep)
  await session.run(inputMap)

  dummy.dispose()
  tStep.dispose()

  onLog('GPU warm-up complete.')
  return session
}

// Builds input map by matching actual model input names to (frame0, frame1, timestep).
// RIFE variants use different names — this handles the most common ones.
export function buildInputMap(inputNames, frame0Tensor, frame1Tensor, timestepTensor) {
  const map = {}
  for (const name of inputNames) {
    const n = name.toLowerCase()
    if (n.includes('0') || n === 'img0' || n === 'frame0' || n === 'input_frame0') {
      map[name] = frame0Tensor
    } else if (n.includes('1') || n === 'img1' || n === 'frame1' || n === 'input_frame1') {
      map[name] = frame1Tensor
    } else if (n.includes('time') || n.includes('step') || n === 't') {
      map[name] = timestepTensor
    }
  }
  // Fallback: positional assignment if heuristic fails
  if (Object.keys(map).length < inputNames.length) {
    const [n0, n1, nt] = inputNames
    map[n0] = frame0Tensor
    if (n1) map[n1] = frame1Tensor
    if (nt) map[nt] = timestepTensor
  }
  return map
}
