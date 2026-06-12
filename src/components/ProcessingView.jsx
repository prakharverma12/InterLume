import { useEffect, useRef, useState } from 'react'
import { PHASE } from '../lib/fsm.js'

export default function ProcessingView({ phase, progress, stage, logs, originalUrl, outputUrl, onDownload, onReset }) {
  const logRef = useRef(null)
  const [displayFps, setDisplayFps] = useState(24)

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  useEffect(() => {
    if (phase !== PHASE.PROCESSING) return
    const next = Math.round(24 + 36 * Math.min(progress / 100, 1))
    setDisplayFps(prev => next !== prev ? next : prev)
  }, [progress, phase])

  const isComplete = !!outputUrl
  const displayStage = isComplete
    ? 'Complete!'
    : phase === PHASE.INITIALIZING
      ? 'Initializing model...'
      : stage || 'Interpolating...'

  return (
    <div className="processing-page">
      <div className="processing-card">
        <h2 className="processing-title">SmoothSlomo</h2>
        <p className={`processing-stage${isComplete ? ' processing-stage--complete' : ''}`}>
          {displayStage}
        </p>

        {originalUrl && (
          <div className="scan-preview">
            <video src={isComplete ? outputUrl : originalUrl} autoPlay loop muted playsInline />
            {!isComplete && <div className="scan-line" />}
            <div className="fps-counter">
              <span>24</span>
              <span style={{ color: 'var(--accent)', margin: '0 4px' }}>→</span>
              <span style={{ color: 'var(--success)' }}>{displayFps}fps</span>
            </div>
          </div>
        )}

        <div className="progress-bar-wrap">
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          <div className="progress-bar-thumb" style={{ left: `${Math.min(progress, 99.5)}%` }} />
        </div>
        <p className="progress-pct">{Math.round(progress)}%</p>

        {isComplete && (
          <div className="complete-actions">
            <button className="download-btn" data-testid="download-btn" onClick={onDownload}>
              Download MP4
            </button>
            <button className="reset-btn" onClick={onReset}>
              Process another
            </button>
          </div>
        )}

        <div className="log-terminal" data-testid="log" ref={logRef}>
          {logs.map((line, i) => (
            <p key={i} className="log-line">
              <span className="log-prompt">›</span> {line}
            </p>
          ))}
          {logs.length === 0 && (
            <p className="log-line log-line--dim">Waiting for output...</p>
          )}
        </div>
      </div>
    </div>
  )
}
