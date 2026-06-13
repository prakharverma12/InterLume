import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Vite intercepts dynamic import() of .mjs files and runs them through its
// transform pipeline, which breaks Emscripten-generated WASM glue code.
// This plugin intercepts /onnx-wasm/*.mjs requests early (before Vite's
// module resolver) and serves the raw file from node_modules.
function onnxWasmRawPlugin() {
  return {
    name: 'onnx-wasm-raw',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/^\/onnx-wasm\/(ort-wasm[^?]*)/)
        if (!match) return next()
        const fileName = match[1]
        const filePath = resolve('node_modules/onnxruntime-web/dist', fileName)
        const mime = fileName.endsWith('.wasm') ? 'application/wasm' : 'application/javascript'
        res.setHeader('Content-Type', mime)
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        createReadStream(filePath).on('error', () => next()).pipe(res)
      })
    },
  }
}

// Copies ONNX wasm+mjs files flat into dist/onnx-wasm after Rolldown finishes,
// avoiding vite-plugin-static-copy's path-preservation bug with Vite 8.
function onnxCopyPlugin() {
  let outDir = 'dist'
  return {
    name: 'onnx-copy',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    writeBundle() {
      const srcDir = resolve('node_modules/onnxruntime-web/dist')
      const destDir = resolve(outDir, 'onnx-wasm')
      mkdirSync(destDir, { recursive: true })
      for (const file of readdirSync(srcDir)) {
        if (/^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(file)) {
          copyFileSync(resolve(srcDir, file), resolve(destDir, file))
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    onnxWasmRawPlugin(),
    onnxCopyPlugin(),
  ],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
    include: ['mp4box'],
  },
  worker: {
    format: 'es',
  },
})
