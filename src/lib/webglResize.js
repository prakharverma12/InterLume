export function paddedDims(w, h) {
  return {
    paddedW: Math.ceil(w / 32) * 32,
    paddedH: Math.ceil(h / 32) * 32,
  }
}

const VERT_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uOrigSize;
uniform vec2 uPadSize;
out vec4 fragColor;
void main() {
  vec2 scaledUv = vUv * uPadSize / uOrigSize;
  if (scaledUv.x > 1.0 || scaledUv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  } else {
    fragColor = texture(uFrame, scaledUv);
  }
}`

function compileShader(gl, type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile error: ' + gl.getShaderInfoLog(s))
  }
  return s
}

function compileProgram(gl, vertSrc, fragSrc) {
  const prog = gl.createProgram()
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vertSrc))
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fragSrc))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(prog))
  }
  return prog
}

export function createGLContext() {
  const canvas = new OffscreenCanvas(1, 1)
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  })
  if (!gl) throw new Error('WebGL2 unavailable in worker')

  const program = compileProgram(gl, VERT_SRC, FRAG_SRC)
  gl.useProgram(program)

  // Full-screen quad
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW)
  const posLoc = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(posLoc)
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

  const uFrame   = gl.getUniformLocation(program, 'uFrame')
  const uOrigSize = gl.getUniformLocation(program, 'uOrigSize')
  const uPadSize  = gl.getUniformLocation(program, 'uPadSize')

  // Texture for input frame
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  // FBO objects — sized and attached in resizeGLBuffers
  const fbo = gl.createFramebuffer()
  const fboTex = gl.createTexture()

  return { gl, program, tex, fbo, fboTex, uFrame, uOrigSize, uPadSize }
}

// Call once after video dimensions are known. Sets up all per-video GPU resources
// and pre-allocates CPU buffers so frameToFloatCHW/floatCHWToVideoFrame never allocate.
export function resizeGLBuffers(ctx, paddedW, paddedH, origW, origH) {
  const { gl, fbo, fboTex } = ctx

  gl.canvas.width  = paddedW
  gl.canvas.height = paddedH
  gl.viewport(0, 0, paddedW, paddedH)

  // Allocate immutable FBO texture once — no per-frame realloc
  gl.bindTexture(gl.TEXTURE_2D, fboTex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, paddedW, paddedH)

  // Attach once
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  // Pre-allocate CPU buffers
  ctx.pixels   = new Uint8Array(paddedW * paddedH * 4)
  ctx.rgbaBuf  = new Uint8ClampedArray(origW * origH * 4)
  ctx.paddedW  = paddedW
  ctx.paddedH  = paddedH
  ctx.origW    = origW
  ctx.origH    = origH
}

// Extracts a Float32Array in CHW RGB layout, normalized to [0,1], padded to paddedW x paddedH.
// resizeGLBuffers must be called before the first use.
export async function frameToFloatCHW(videoFrame, paddedW, paddedH, ctx) {
  const { gl, tex, fbo, uOrigSize, uPadSize } = ctx
  const origW = videoFrame.displayWidth
  const origH = videoFrame.displayHeight

  // Upload VideoFrame as texture
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoFrame)

  gl.uniform2f(uOrigSize, origW, origH)
  gl.uniform2f(uPadSize, paddedW, paddedH)

  // Bind input texture back as uniform
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.drawArrays(gl.TRIANGLES, 0, 6)

  // Read back into pre-allocated buffer
  gl.readPixels(0, 0, paddedW, paddedH, gl.RGBA, gl.UNSIGNED_BYTE, ctx.pixels)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  // Convert interleaved RGBA uint8 → planar CHW float32 [3, H, W]
  const chw = new Float32Array(3 * paddedH * paddedW)
  const planeSize = paddedH * paddedW
  for (let i = 0; i < planeSize; i++) {
    chw[i]                 = ctx.pixels[i * 4]     / 255.0  // R
    chw[planeSize + i]     = ctx.pixels[i * 4 + 1] / 255.0  // G
    chw[2 * planeSize + i] = ctx.pixels[i * 4 + 2] / 255.0  // B
  }
  return chw
}

// Converts a CHW float32 tensor output [3, H, W] back to a VideoFrame at originalW x originalH.
// Uses ctx.rgbaBuf — resizeGLBuffers must be called before use.
export function floatCHWToVideoFrame(chw, paddedW, paddedH, origW, origH, timestampUs, durationUs, ctx) {
  const planeSize = paddedH * paddedW
  const rgba = ctx.rgbaBuf

  for (let y = 0; y < origH; y++) {
    for (let x = 0; x < origW; x++) {
      const srcIdx = y * paddedW + x
      const dstIdx = (y * origW + x) * 4
      // Uint8ClampedArray auto-clamps to [0, 255] — no Math.min/max/round needed
      rgba[dstIdx]     = chw[srcIdx]                 * 255
      rgba[dstIdx + 1] = chw[planeSize + srcIdx]     * 255
      rgba[dstIdx + 2] = chw[2 * planeSize + srcIdx] * 255
      rgba[dstIdx + 3] = 255
    }
  }

  return new VideoFrame(rgba, {
    format: 'RGBA',
    codedWidth: origW,
    codedHeight: origH,
    timestamp: timestampUs,
    duration: durationUs,
  })
}
