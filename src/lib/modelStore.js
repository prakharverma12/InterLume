const DB_NAME = 'smooth-slomo-models'
const STORE   = 'models'
const VERSION = 1

export const MODEL_URLS = {
  'rife_fp16.onnx': 'https://huggingface.co/yuvraj108c/rife-onnx/resolve/main/rife49_ensemble_True_scale_1_sim.onnx',
  'rife_int8.onnx': 'https://huggingface.co/yuvraj108c/rife-onnx/resolve/main/rife48_ensemble_True_scale_1_sim.onnx',
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE)
    }
    req.onsuccess  = (e) => resolve(e.target.result)
    req.onerror    = (e) => reject(e.target.error)
  })
}

export async function hasModel(key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getKey(key)
    req.onsuccess = (e) => resolve(e.target.result !== undefined)
    req.onerror   = (e) => reject(e.target.error)
  })
}

export async function loadModel(key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = (e) => resolve(e.target.result ?? null)
    req.onerror   = (e) => reject(e.target.error)
  })
}

export async function saveModel(key, buffer) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(buffer, key)
    req.onsuccess = () => resolve()
    req.onerror   = (e) => reject(e.target.error)
  })
}

export async function deleteModel(key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).delete(key)
    req.onsuccess = () => resolve()
    req.onerror   = (e) => reject(e.target.error)
  })
}

export async function listCachedModels() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAllKeys()
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror   = (e) => reject(e.target.error)
  })
}

// Fetches model from MODEL_URLS[key], streams download progress via onProgress(0-100),
// persists to IDB, and returns the ArrayBuffer.
export async function fetchAndCacheModel(key, onProgress) {
  const url = MODEL_URLS[key]
  if (!url) throw new Error(`No download URL configured for model: ${key}`)

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`)
  const contentType = response.headers.get('Content-Type') || ''
  if (contentType.includes('text/html')) {
    throw new Error(`Model file not found at ${url} — add the .onnx files to public/models/`)
  }

  const total    = Number(response.headers.get('Content-Length')) || 0
  const reader   = response.body.getReader()
  const chunks   = []
  let received   = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (total > 0) onProgress(Math.min(99, Math.round((received / total) * 100)))
  }

  // Assemble chunks into a single contiguous buffer
  const combined = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }

  const arrayBuffer = combined.buffer
  await saveModel(key, arrayBuffer)
  onProgress(100)
  return arrayBuffer
}
