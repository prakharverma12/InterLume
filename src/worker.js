import * as ort from 'onnxruntime-web/webgpu'
import * as MP4Box from 'mp4box'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { MSG } from './lib/workerProtocol.js'
import { BATCH_CONFIG } from './lib/fsm.js'
import { createSession, buildInputMap } from './lib/onnxSession.js'
import { createGLContext, paddedDims, resizeGLBuffers, frameToFloatCHW, floatCHWToVideoFrame } from './lib/webglResize.js'
import { loadModel, fetchAndCacheModel, deleteModel } from './lib/modelStore.js'
import { makeDbg } from './lib/debugLog.js'

console.log('[worker] loaded')

let session = null
let glCtx = null
let batchSize = 4

function log(line) {
  postMessage({ type: MSG.LOG, line })
}

function progress(value, stage) {
  postMessage({ type: MSG.PROGRESS, value, stage })
}

const dbg = makeDbg(log)

// ─── INIT ───────────────────────────────────────────────────────────────────

async function handleInit({ hwTier }) {
  try {
    const cfg      = BATCH_CONFIG[hwTier] || BATCH_CONFIG.STANDARD
    batchSize      = cfg.batchSize
    const modelKey = cfg.modelFile

    glCtx = createGLContext()
    log(`Hardware tier: ${hwTier} — batch size ${batchSize}`)

    let modelBuffer = await loadModel(modelKey)

    if (!modelBuffer) {
      log(`Model not cached — downloading ${modelKey}...`)
      progress(0, `Downloading model...`)
      modelBuffer = await fetchAndCacheModel(modelKey, (pct) => {
        progress(pct, `Downloading model (${pct}%)`)
      })
      log(`Model downloaded and cached (${(modelBuffer.byteLength / 1024 / 1024).toFixed(1)} MB)`)
    } else {
      log(`Model loaded from cache: ${modelKey}`)
      progress(5, 'Model ready — loading session...')
    }

    try {
      session = await createSession(modelBuffer, log)
    } catch (err) {
      // Corrupt cache (interrupted download) causes "protobuf parsing failed".
      // Wipe the bad entry and retry with a fresh download once.
      if (err.message.includes('protobuf') || err.message.includes('parse')) {
        log(`Cached model appears corrupt — re-downloading ${modelKey}...`)
        await deleteModel(modelKey)
        progress(0, 'Re-downloading model...')
        modelBuffer = await fetchAndCacheModel(modelKey, (pct) => {
          progress(pct, `Re-downloading model (${pct}%)`)
        })
        log(`Re-download complete (${(modelBuffer.byteLength / 1024 / 1024).toFixed(1)} MB)`)
        session = await createSession(modelBuffer, log)
      } else {
        throw err
      }
    }
    postMessage({ type: MSG.WORKER_READY })
  } catch (err) {
    postMessage({ type: MSG.ERROR, message: `Init failed: ${err.message}` })
  }
}

// ─── PROCESS FILE ────────────────────────────────────────────────────────────

async function handleProcessFile({ file, slowmoFactor = 0.25 }) {
  try {
    log('Reading file...')
    progress(8, 'Reading file...')
    const fileMB = (file.size / 1024 / 1024).toFixed(1)
    log(`File size: ${fileMB} MB`)
    const t0 = performance.now()
    const arrayBuffer = await file.arrayBuffer()
    log(`File read: ${((performance.now() - t0) / 1000).toFixed(2)}s`)
    arrayBuffer.fileStart = 0

    progress(12, 'Demuxing video...')
    log('Demuxing MP4...')
    const t1 = performance.now()
    let lastDemuxLog = 0
    const { videoTrack, samples, avcDescription } = await demuxFile(arrayBuffer, (got, total) => {
      const pct = Math.round((got / total) * 100)
      const now = performance.now()
      if (now - lastDemuxLog >= 500) {
        lastDemuxLog = now
        log(`Demuxing: ${got}/${total} frames (${pct}%)`)
        progress(12 + Math.round(pct * 0.03), 'Demuxing video...')
      }
    })
    log(`Demux done: ${samples.length} frames, ${videoTrack.codec} — ${((performance.now() - t1) / 1000).toFixed(2)}s`)
    dbg(`Track: id=${videoTrack.id} codec=${videoTrack.codec} timescale=${videoTrack.timescale} nb_samples=${videoTrack.nb_samples}`)
    dbg(`avcDescription: ${avcDescription ? `present (${avcDescription.byteLength} bytes)` : 'NULL — decoder will run without description'}`)
    if (samples.length > 0) {
      const syncFlags = samples.slice(0, Math.min(8, samples.length)).map((s, i) => `[${i}]is_sync=${s.is_sync}(${typeof s.is_sync})`).join(' ')
      dbg(`First sample sync flags: ${syncFlags}`)
    }
    progress(15, 'Setting up codecs...')

    const origW = videoTrack.track_width
    const origH = videoTrack.track_height
    const { paddedW, paddedH } = paddedDims(origW, origH)

    log(`Dimensions: ${origW}x${origH} → padded ${paddedW}x${paddedH}`)

    // One-time GPU buffer setup for this video's dimensions
    resizeGLBuffers(glCtx, paddedW, paddedH, origW, origH)

    // Source FPS from track timescale + sample durations
    const sampleDurationUs = Math.round(
      (samples[0]?.duration / videoTrack.timescale) * 1_000_000
    ) || 66_667

    // Dynamic interpolation config derived from slowmo factor
    const numInterpFrames      = Math.max(1, Math.round(1 / slowmoFactor) - 1)
    const timesteps            = Array.from({ length: numInterpFrames }, (_, i) => (i + 1) / (numInterpFrames + 1))
    // Keep per-frame duration = input frame duration → output is (numInterp+1)× longer (true slowmo)
    const outputFrameDurationUs = sampleDurationUs
    const inputFps             = Math.max(1, Math.round(1_000_000 / sampleDurationUs))

    log(`Slowmo ×${numInterpFrames + 1}: ${numInterpFrames} interp frame(s) per pair — output ~${numInterpFrames + 1}× longer`)
    log(`Input frame duration: ${sampleDurationUs}µs (${inputFps} fps)`)

    // Set up WebCodecs decoder
    // frameQueue is the live channel between the decoder output callback and the
    // consumer loop. frameWaiters holds resolve functions for consumers waiting
    // on the next frame — using an array supports multiple concurrent waiters.
    const frameQueue = []
    const frameWaiters = []
    let decoderError = null
    let decoderOutputCount = 0

    const decoder = new VideoDecoder({
      output(frame) {
        decoderOutputCount++
        dbg(`Decoder output #${decoderOutputCount}: ts=${frame.timestamp}`)
        frameQueue.push(frame)
        if (frameWaiters.length > 0) frameWaiters.shift()()
      },
      error(e) {
        dbg(`Decoder error callback: ${e.message}`)
        decoderError = e.message
        // Wake any waiting consumers so they can throw
        while (frameWaiters.length > 0) frameWaiters.shift()()
      },
    })
    const tCodec = performance.now()
    const decoderCodec = videoTrack.codec.startsWith('avc') ? videoTrack.codec : 'avc1.42001e'
    const decoderConfig = {
      codec: decoderCodec,
      codedWidth: origW,
      codedHeight: origH,
      hardwareAcceleration: 'prefer-hardware',
      ...(avcDescription != null && { description: avcDescription }),
    }
    dbg(`VideoDecoder.configure: codec=${decoderCodec} ${origW}x${origH} description=${avcDescription != null ? 'yes' : 'NO'} state-before=${decoder.state}`)
    decoder.configure(decoderConfig)
    dbg(`VideoDecoder state after configure: ${decoder.state}`)

    // Set up muxer
    const target = new ArrayBufferTarget()
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: origW, height: origH },
      firstTimestampBehavior: 'offset',
      fastStart: 'in-memory',
    })

    // Set up encoder
    let encoderOutputCount = 0
    const encoder = new VideoEncoder({
      output(chunk, meta) {
        encoderOutputCount++
        dbg(`Encoder output #${encoderOutputCount}: type=${chunk.type} ts=${chunk.timestamp} size=${chunk.byteLength}`)
        muxer.addVideoChunk(chunk, meta)
      },
      error(e) {
        dbg(`Encoder error callback: ${e.message}`)
        decoderError = e.message
      },
    })
    dbg(`VideoEncoder.configure: avc1.42001e ${origW}x${origH} ${inputFps}fps 8Mbps state-before=${encoder.state}`)
    encoder.configure({
      codec: 'avc1.42001e',
      width: origW,
      height: origH,
      bitrate: 8_000_000,
      framerate: inputFps,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
    })
    dbg(`VideoEncoder state after configure: ${encoder.state}`)
    log(`Codecs configured: ${Math.round(performance.now() - tCodec)}ms`)

    // ─── Concurrent decode + process pipeline ───────────────────────────────
    // Producer feeds encoded chunks to the decoder with a bounded queue so it
    // never floods Chrome's internal decode buffer. Consumer processes frame
    // pairs immediately as they arrive, so decoded VideoFrames don't pile up
    // in memory. Both run concurrently via Promise.all — no intermediate
    // flush() calls, so the key-frame-after-flush requirement never applies.

    const totalFrames = samples.length
    let encodedPairs = 0
    let lastProgressMs = 0
    let pairTimeSum = 0
    const tProcess = performance.now()

    const waitForFrame = () => new Promise(r => {
      if (frameQueue.length > 0) r()
      else frameWaiters.push(r)
    })

    // Producer: submit all decode calls, keeping queue ≤ MAX_QUEUED at a time
    const MAX_QUEUED = 8
    const produce = async () => {
      dbg(`Decode pass start: ${samples.length} samples, decoder.state=${decoder.state}`)
      for (let si = 0; si < samples.length; si++) {
        while (decoder.decodeQueueSize >= MAX_QUEUED) {
          await new Promise(r => setTimeout(r, 0))
        }
        const sample = samples[si]
        const keyType = (si === 0 || sample.is_sync) ? 'key' : 'delta'
        const ts = Math.round((sample.cts / videoTrack.timescale) * 1_000_000)
        if (si < 3 || sample.is_sync) {
          dbg(`decode[${si}] type=${keyType} is_sync=${sample.is_sync} ts=${ts} decodeQueueSize=${decoder.decodeQueueSize}`)
        }
        decoder.decode(new EncodedVideoChunk({
          type: keyType,
          timestamp: ts,
          duration: Math.round((sample.duration / videoTrack.timescale) * 1_000_000),
          data: sample.data,
        }))
      }
      dbg(`decoder.flush() called — state=${decoder.state} decodeQueueSize=${decoder.decodeQueueSize}`)
      await decoder.flush()
      dbg(`decoder.flush() resolved — outputCount=${decoderOutputCount}`)
      // Wake consumer if it's still waiting after all outputs have fired
      while (frameWaiters.length > 0) frameWaiters.shift()()
    }

    // Consumer: process pairs one by one as decoded frames arrive
    const consume = async () => {
      let prevFrame = null
      let prevChw = null
      let outputFrameIdx = 0
      for (let fi = 0; fi < totalFrames; fi++) {
        await waitForFrame()
        if (decoderError) throw new Error(decoderError)
        const frame = frameQueue.shift()
        if (prevFrame !== null) {
          if (fi < 3) dbg(`pair[${fi - 1}]: A.ts=${prevFrame.timestamp} B.ts=${frame.timestamp} outIdx=${outputFrameIdx}`)
          const tPair = performance.now()
          const result = await processPair(prevFrame, frame, encoder, origW, origH, paddedW, paddedH, outputFrameDurationUs, timesteps, prevChw, outputFrameIdx)
          prevChw = result.chw
          outputFrameIdx = result.nextIdx
          pairTimeSum += performance.now() - tPair
          prevFrame.close()
          encodedPairs++
          const pct = Math.round((encodedPairs / (totalFrames - 1)) * 100)
          const now = performance.now()
          if (now - lastProgressMs >= 250) {
            lastProgressMs = now
            const avgMs = Math.round(pairTimeSum / encodedPairs)
            const etaSec = (((totalFrames - 1 - encodedPairs) * avgMs) / 1000).toFixed(0)
            progress(15 + Math.round(pct * 0.84), 'Interpolating...')
            log(`Pair ${encodedPairs}/${totalFrames - 1} (${pct}%) — ${avgMs}ms/pair, ~${etaSec}s left`)
          }
        }
        prevFrame = frame
      }
      // Encode the final frame with a remapped timestamp
      if (prevFrame) {
        const lastTs = outputFrameIdx * outputFrameDurationUs
        const remapped = new VideoFrame(prevFrame, { timestamp: lastTs, duration: outputFrameDurationUs })
        encoder.encode(remapped)
        remapped.close()
        prevFrame.close()
      }
      for (const f of frameQueue.splice(0)) f.close()
    }

    await Promise.all([produce(), consume()])

    dbg(`encoder.flush() called — state=${encoder.state} encoderOutputCount=${encoderOutputCount}`)
    log('Flushing encoder...')
    await encoder.flush()
    dbg(`encoder.flush() resolved — outputCount=${encoderOutputCount}`)
    encoder.close()
    decoder.close()

    log('Finalizing MP4...')
    muxer.finalize()

    const { buffer } = target
    const totalSec = ((performance.now() - tProcess) / 1000).toFixed(1)
    progress(100, 'Done!')
    log(`Complete — output: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB, total: ${totalSec}s (avg ${Math.round(pairTimeSum / encodedPairs)}ms/pair)`)

    postMessage({ type: MSG.SUCCESS, buffer }, [buffer])
  } catch (err) {
    postMessage({ type: MSG.ERROR, message: `Processing failed: ${err.message}\n${err.stack}` })
  }
}

// ─── PAIR PROCESSOR ──────────────────────────────────────────────────────────
// precomputedChw0: cached CHW float array for frameA (from previous pair's frameB).
//                 If provided, skips the GPU→CPU readback for frameA entirely.
// Returns chw1 (frameB's CHW) so the caller can cache it as the next pair's chw0.

async function processPair(frameA, frameB, encoder, origW, origH, paddedW, paddedH, durationUs, timesteps, precomputedChw0 = null, startOutputIdx = 0) {
  let f0t = null
  let f1t = null
  const outputFrames = []

  try {
    const chw0 = precomputedChw0 ?? await frameToFloatCHW(frameA, paddedW, paddedH, glCtx)
    const chw1 = await frameToFloatCHW(frameB, paddedW, paddedH, glCtx)

    f0t = new ort.Tensor('float32', chw0, [1, 3, paddedH, paddedW])
    f1t = new ort.Tensor('float32', chw1, [1, 3, paddedH, paddedW])

    // Encode original frameA with a sequentially remapped timestamp so that
    // inserting interpolated frames between every pair actually extends duration.
    const frameATs = startOutputIdx * durationUs
    const remappedA = new VideoFrame(frameA, { timestamp: frameATs, duration: durationUs })
    encoder.encode(remappedA)
    remappedA.close()

    for (let ti = 0; ti < timesteps.length; ti++) {
      const t = timesteps[ti]
      const stepTensor = new ort.Tensor('float32', new Float32Array([t]), [1])

      let outputs
      try {
        const inputMap = buildInputMap(session.inputNames, f0t, f1t, stepTensor)
        outputs = await session.run(inputMap)
      } finally {
        stepTensor.dispose()
      }

      const outputName = session.outputNames[0]
      const outTensor = outputs[outputName]

      // Each output frame occupies one slot after frameA in the output sequence.
      const interpTs = (startOutputIdx + ti + 1) * durationUs
      const interpFrame = floatCHWToVideoFrame(
        outTensor.data, paddedW, paddedH, origW, origH,
        interpTs, durationUs, glCtx
      )
      outputFrames.push({ interpFrame, outTensor })
    }

    // Encode interpolated frames in order
    for (const { interpFrame, outTensor } of outputFrames) {
      encoder.encode(interpFrame)
      interpFrame.close()
      outTensor.dispose()
    }

    return { chw: chw1, nextIdx: startOutputIdx + 1 + timesteps.length }

  } finally {
    f0t?.dispose()
    f1t?.dispose()
    // Clean up any remaining output frames on error
    for (const { interpFrame, outTensor } of outputFrames) {
      try { interpFrame.close() } catch {}
      try { outTensor.dispose() } catch {}
    }
  }
}

// ─── MP4BOX DEMUX ────────────────────────────────────────────────────────────

function demuxFile(arrayBuffer, onProgress) {
  return new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile()
    let videoTrack = null
    const allSamples = []
    let totalSamples = 0
    let resolved = false
    let avcDescription = null

    function done() {
      if (!resolved) {
        resolved = true
        resolve({ videoTrack, samples: allSamples, avcDescription })
      }
    }

    mp4.onReady = (info) => {
      videoTrack = info.videoTracks[0]
      if (!videoTrack) {
        reject(new Error('No video track found in file'))
        return
      }
      // Extract avcC (AVCDecoderConfigurationRecord) from the moov box tree.
      try {
        const traks = mp4.moov?.traks ?? []
        const trak = traks.find(t => t.tkhd?.track_id === videoTrack.id) ?? traks[0]
        const stsd = trak?.mdia?.minf?.stbl?.stsd
        const entry = stsd?.entries?.[0]

        console.log('[demux] stsd:', stsd)
        console.log('[demux] entry type:', entry?.type, '  entry keys:', entry ? Object.keys(entry) : null)
        console.log('[demux] entry.avcC:', entry?.avcC)

        // mp4box stores avcC as a named property in most versions; some builds put it
        // inside a generic boxes[] child array instead.
        const avcC = entry?.avcC
          ?? (Array.isArray(entry?.boxes) ? entry.boxes.find(b => b.type === 'avcC') : null)

        console.log('[demux] resolved avcC:', avcC)

        if (avcC) {
          console.log('[demux] avcC keys:', Object.keys(avcC))
          // Serialize via mp4box's own DataStream — avoids depending on internal field names
          const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
          avcC.write(stream)
          // The first 8 bytes are the box header (4-byte size + 4-byte type); skip them
          avcDescription = new Uint8Array(stream.buffer, 8, stream.position - 8)
          console.log('[demux] avcDescription built via DataStream:', avcDescription.byteLength, 'bytes')
        } else {
          console.warn('[demux] avcC not found — VideoDecoder will likely fail for AVCC-format H.264')
        }
      } catch (err) {
        console.error('[demux] avcC extraction threw:', err.message, err.stack)
      }

      totalSamples = videoTrack.nb_samples
      mp4.setExtractionOptions(videoTrack.id, null, { nbSamples: Infinity })
      mp4.start()
    }

    mp4.onSamples = (_id, _user, samples) => {
      allSamples.push(...samples)
      if (onProgress && totalSamples > 0) {
        onProgress(allSamples.length, totalSamples)
      }
      // Resolve as soon as all samples are collected — onFlush may not fire in all mp4box versions
      if (totalSamples > 0 && allSamples.length >= totalSamples) {
        done()
      }
    }

    // onFlush fires when mp4box finishes flushing — acts as a fallback if onSamples
    // never reaches totalSamples (e.g. file reports wrong nb_samples)
    mp4.onFlush = () => done()

    mp4.onError = (e) => reject(new Error(String(e)))

    mp4.appendBuffer(arrayBuffer)
    mp4.flush()
  })
}



// ─── MESSAGE ROUTER ──────────────────────────────────────────────────────────

self.onmessage = ({ data }) => {
  switch (data.type) {
    case MSG.INIT:
      handleInit(data)
      break
    case MSG.PROCESS_FILE:
      handleProcessFile(data)
      break
    default:
      console.warn('[worker] unknown message type:', data.type)
  }
}
