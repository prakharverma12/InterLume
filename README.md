# InterLume

AI-powered slow-motion video generator that runs entirely in your browser. Drop in an MP4, choose a slowdown factor, and get back a smooth slow-motion video — no uploads, no servers, no installs.

## How it works

InterLume synthesizes new frames between every pair of existing frames using **RIFE** (Real-time Intermediate Flow Estimation), an optical-flow-based AI model. For a 2× slowdown it inserts one frame between every pair; for 4× it inserts three. The output video contains all the original frames plus the synthesized ones, each spaced at the original frame duration, so the action takes proportionally longer to play through.

The entire pipeline runs on-device:

```
MP4 file
  → mp4box (demux H.264 samples + avcC config)
  → WebCodecs VideoDecoder (decode to VideoFrames)
  → WebGL2 (resize + pad to multiples of 32, read back as float CHW tensors)
  → RIFE via onnxruntime-web / WebGPU (synthesize intermediate frames)
  → WebGL2 (convert float CHW tensor back to VideoFrame)
  → WebCodecs VideoEncoder (re-encode as H.264)
  → mp4-muxer (write output MP4 in memory)
  → download
```

The decoder and encoder run concurrently in a producer/consumer pipeline — the producer keeps the decode queue bounded (≤ 8 frames) so Chrome's internal buffer never stalls, while the consumer processes and encodes frame pairs immediately as they arrive.

## Hardware tiers

InterLume detects GPU capability at startup and selects a model and batch size accordingly:

| Tier | Device | Model | Batch size |
|---|---|---|---|
| Mobile / Tablet | Phone, iPad | `rife_int8.onnx` | 1 |
| Eco / Low-End | Integrated GPU | `rife_int8.onnx` | 2 |
| Standard | Mid-range dGPU | `rife_fp16.onnx` | 4 |
| Pro / High-End | High-end dGPU | `rife_fp16.onnx` | 8 |

The INT8 model trades a small quality reduction for significantly lower memory and compute requirements. The FP16 model gives full quality.

## Browser requirements

- Chrome 113+ or Edge 113+ (WebGPU + WebCodecs required)
- Firefox and Safari are not supported (no WebGPU in workers as of writing)

## Tech stack

- **React 19** + **Vite** — UI and build
- **onnxruntime-web** (WebGPU EP) — RIFE inference
- **mp4box** — MP4 demux
- **mp4-muxer** — MP4 mux
- **WebCodecs** — hardware-accelerated H.264 decode + encode
- **WebGL2** — GPU-accelerated frame resize and tensor conversion

## Development

```bash
npm install
npm run dev
```

```bash
npm run build   # production build to dist/
npm run preview # serve the production build locally
```

The ONNX models are fetched on first use and cached in the browser via the Cache API. Subsequent runs load from cache instantly.

## Project structure

```
src/
  worker.js              # all heavy work runs here (off main thread)
  lib/
    webglResize.js       # VideoFrame ↔ CHW float tensor via WebGL2
    onnxSession.js       # ONNX Runtime session setup + input map builder
    modelStore.js        # model fetch, cache, and invalidation
    hardwareDetect.js    # GPU tier detection
    fsm.js               # phase/tier/batch constants
    workerProtocol.js    # worker message type constants
    debugLog.js          # debug logging to both console and UI panel
  components/
    UploadZone.jsx        # file drop + slowmo factor selector
    ProcessingView.jsx    # progress bar, log panel, preview
    ResultView.jsx        # side-by-side original vs output + download
```
