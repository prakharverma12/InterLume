import { useState, useRef, useCallback, useEffect } from 'react'

export default function ResultView({ outputUrl, originalUrl, onReset }) {
  const [splitPct, setSplitPct] = useState(50)
  const [particles, setParticles] = useState([])
  const containerRef = useRef(null)
  const dragging = useRef(false)
  const particleId = useRef(0)

  // Sync both videos to play together
  const origVideoRef = useRef(null)
  const outVideoRef  = useRef(null)

  useEffect(() => {
    const orig = origVideoRef.current
    const out  = outVideoRef.current
    if (!orig || !out) return
    function syncPlay() { out.currentTime = orig.currentTime }
    orig.addEventListener('seeked', syncPlay)
    return () => orig.removeEventListener('seeked', syncPlay)
  }, [])

  function updateSplit(e) {
    const rect = containerRef.current.getBoundingClientRect()
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const pct = ((clientX - rect.left) / rect.width) * 100
    setSplitPct(Math.max(2, Math.min(98, pct)))
  }

  const onPointerDown = useCallback((e) => {
    dragging.current = true
    containerRef.current?.setPointerCapture(e.pointerId)
    updateSplit(e)
  }, [])

  const onPointerMove = useCallback((e) => {
    if (!dragging.current) return
    updateSplit(e)
  }, [])

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  function spawnParticles(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const burst = Array.from({ length: 24 }, (_, i) => {
      const angle = (i / 24) * 2 * Math.PI
      const dist  = 40 + Math.random() * 40
      return {
        id: particleId.current++,
        x: cx,
        y: cy,
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist,
        color: `hsl(${Math.round(Math.random() * 60 + 200)}, 90%, 65%)`,
      }
    })
    setParticles(burst)
    setTimeout(() => setParticles([]), 700)
  }

  function handleDownload(e) {
    spawnParticles(e)
    const a = document.createElement('a')
    a.href = outputUrl
    a.download = 'interlume_output.mp4'
    a.click()
  }

  return (
    <div className="result-page">
      <h2 className="result-title">60fps Output Ready</h2>
      <p className="result-sub">Drag the divider to compare original vs interpolated</p>

      <div
        ref={containerRef}
        className="split-container"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ cursor: 'col-resize', userSelect: 'none' }}
      >
        {/* Output video — clipped on right */}
        <video
          ref={outVideoRef}
          src={outputUrl}
          autoPlay loop muted playsInline
          className="split-video split-video--output"
          style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
        />
        {/* Original video — clipped on left */}
        <video
          ref={origVideoRef}
          src={originalUrl}
          autoPlay loop muted playsInline
          className="split-video split-video--original"
          style={{ clipPath: `inset(0 0 0 ${splitPct}%)` }}
        />
        {/* Divider handle */}
        <div className="split-divider" style={{ left: `${splitPct}%` }}>
          <div className="split-handle" />
        </div>
        {/* Labels */}
        <span className="split-label split-label--left">60fps</span>
        <span className="split-label split-label--right">Original</span>
      </div>

      <div className="result-actions">
        <button className="download-btn" onClick={handleDownload} style={{ position: 'relative', overflow: 'visible' }}>
          Download MP4
          {particles.map(p => (
            <span
              key={p.id}
              className="particle"
              style={{
                left: p.x,
                top: p.y,
                '--dx': `${p.dx}px`,
                '--dy': `${p.dy}px`,
                background: p.color,
              }}
            />
          ))}
        </button>
        <button className="reset-btn" onClick={onReset}>
          Process another
        </button>
      </div>
    </div>
  )
}
