import { useReducer, useRef, useCallback } from 'react'
import { PHASE } from './lib/fsm.js'
import { MSG } from './lib/workerProtocol.js'
import UploadZone from './components/UploadZone.jsx'
import ProcessingView from './components/ProcessingView.jsx'
import ResultView from './components/ResultView.jsx'

const initialState = {
  phase: PHASE.IDLE,
  file: null,
  hwTier: null,
  progress: 0,
  stage: '',
  logs: [],
  outputUrl: null,
  originalUrl: null,
  error: null,
}

function reducer(state, action) {
  switch (action.type) {
    case 'FILE_SELECTED':
      return { ...state, file: action.file, hwTier: action.hwTier, error: null }
    case 'START':
      return { ...state, phase: PHASE.INITIALIZING, progress: 0, logs: [], error: null }
    case 'WORKER_READY':
      return { ...state, phase: PHASE.PROCESSING }
    case 'PROGRESS':
      return { ...state, progress: action.value, stage: action.stage || state.stage }
    case 'LOG':
      return { ...state, logs: [...state.logs.slice(-199), action.line] }
    case 'SUCCESS':
      return { ...state, phase: PHASE.SUCCESS, outputUrl: action.url, progress: 100 }
    case 'ERROR':
      return { ...state, phase: PHASE.IDLE, error: action.message }
    case 'RESET':
      return { ...initialState }
    default:
      return state
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const workerRef = useRef(null)
  const originalUrlRef = useRef(null)

  const handleWorkerMessage = useCallback(({ data }) => {
    switch (data.type) {
      case MSG.WORKER_READY:
        dispatch({ type: 'WORKER_READY' })
        // Start processing once worker is ready
        workerRef.current?.postMessage({
          type: MSG.PROCESS_FILE,
          file: state.file,
        })
        break
      case MSG.PROGRESS:
        dispatch({ type: 'PROGRESS', value: data.value, stage: data.stage })
        break
      case MSG.LOG:
        dispatch({ type: 'LOG', line: data.line })
        break
      case MSG.SUCCESS: {
        const blob = new Blob([data.buffer], { type: 'video/mp4' })
        const url = URL.createObjectURL(blob)
        dispatch({ type: 'SUCCESS', url })
        break
      }
      case MSG.ERROR:
        dispatch({ type: 'ERROR', message: data.message })
        workerRef.current?.terminate()
        workerRef.current = null
        break
    }
  }, [state.file])

  const handleStart = useCallback((file, hwTier, slowmoFactor) => {
    // Revoke previous object URLs
    if (originalUrlRef.current) URL.revokeObjectURL(originalUrlRef.current)
    const originalUrl = URL.createObjectURL(file)
    originalUrlRef.current = originalUrl

    dispatch({ type: 'FILE_SELECTED', file, hwTier })
    dispatch({ type: 'START' })

    const worker = new Worker(
      new URL('./worker.js', import.meta.url),
      { type: 'module' }
    )
    worker.onmessage = (e) => {
      handleWorkerMessageWithFile(e, file, slowmoFactor)
    }
    workerRef.current = worker
    worker.postMessage({ type: MSG.INIT, hwTier })
  }, [])

  const handleWorkerMessageWithFile = useCallback((e, file, slowmoFactor) => {
    const { data } = e
    switch (data.type) {
      case MSG.WORKER_READY:
        dispatch({ type: 'WORKER_READY' })
        workerRef.current?.postMessage({ type: MSG.PROCESS_FILE, file, slowmoFactor })
        break
      case MSG.PROGRESS:
        dispatch({ type: 'PROGRESS', value: data.value, stage: data.stage })
        break
      case MSG.LOG:
        dispatch({ type: 'LOG', line: data.line })
        break
      case MSG.SUCCESS: {
        const blob = new Blob([data.buffer], { type: 'video/mp4' })
        const url = URL.createObjectURL(blob)
        dispatch({ type: 'SUCCESS', url })
        workerRef.current = null
        break
      }
      case MSG.ERROR:
        dispatch({ type: 'ERROR', message: data.message })
        workerRef.current?.terminate()
        workerRef.current = null
        break
    }
  }, [])

  const handleReset = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = null
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl)
    dispatch({ type: 'RESET' })
  }, [state.outputUrl])

  return (
    <div className="app">
      {state.error && (
        <div className="error-banner" data-testid="error-banner">
          <strong>Error:</strong> {state.error}
          <button onClick={() => dispatch({ type: 'RESET' })}>Dismiss</button>
        </div>
      )}

      {state.phase === PHASE.IDLE && (
        <UploadZone onStart={handleStart} />
      )}

      {(state.phase === PHASE.INITIALIZING || state.phase === PHASE.PROCESSING || state.phase === PHASE.SUCCESS) && (
        <ProcessingView
          phase={state.phase}
          progress={state.progress}
          stage={state.stage}
          logs={state.logs}
          originalUrl={originalUrlRef.current}
          outputUrl={state.outputUrl}
          onDownload={() => {
            const a = document.createElement('a')
            a.href = state.outputUrl
            a.download = 'slowmo_60fps.mp4'
            a.click()
          }}
          onReset={handleReset}
        />
      )}
    </div>
  )
}
