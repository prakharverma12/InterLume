import { useState, useEffect, useRef } from 'react'
import { detectHardwareTier } from '../lib/hardwareDetect.js'
import { HW_TIER, HW_TIER_LABELS, BATCH_CONFIG } from '../lib/fsm.js'
import { listCachedModels, deleteModel } from '../lib/modelStore.js'

const TIER_ORDER = [HW_TIER.MOBILE, HW_TIER.LOW_END, HW_TIER.STANDARD, HW_TIER.HIGH_END]

export default function UploadZone({ onStart }) {
  const [hwTier, setHwTier] = useState(HW_TIER.STANDARD)
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [cachedModels, setCachedModels] = useState([])
  const [showCacheManager, setShowCacheManager] = useState(false)
  const [slowdownMultiplier, setSlowdownMultiplier] = useState(4)
  const [isMorphing, setIsMorphing] = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    detectHardwareTier((...args) => console.log('[hw]', ...args)).then(setHwTier)
    refreshCache()
  }, [])

  function refreshCache() {
    listCachedModels().then(setCachedModels).catch(() => setCachedModels([]))
  }

  async function handleDeleteModel(key) {
    await deleteModel(key)
    refreshCache()
  }

  function handleDragEnter(e) {
    e.preventDefault()
    setDragging(true)
  }
  function handleDragLeave(e) {
    e.preventDefault()
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false)
  }
  function handleDragOver(e) { e.preventDefault() }
  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith('video/')) setFile(f)
  }
  function handleFileInput(e) {
    const f = e.target.files[0]
    if (f) setFile(f)
  }

  const selectedIdx    = TIER_ORDER.indexOf(hwTier)
  const requiredModel  = BATCH_CONFIG[hwTier]?.modelFile
  const isCached       = cachedModels.includes(requiredModel)
  const actualSlowdown = Math.round(slowdownMultiplier)
  const slowmoFactor   = 1 / slowdownMultiplier

  function handleSubmit() {
    if (!file) return
    setIsMorphing(true)
    setTimeout(() => onStart(file, hwTier, slowmoFactor), 380)
  }

  return (
    <div className="upload-page">
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%' }}>
        <header className="upload-header">
          <h1 className="logo">
            <span className="logo-neon-cyan">Inter-</span><span className="logo-neon-magenta">Lum<span className="logo-flicker">e</span></span>
            <span className="logo-orbit-ball" aria-hidden="true" />
          </h1>
          <p className="tagline">On-device temporal frame synthesis · zero upload · fully private</p>
          <span className="secure-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            100% Local &amp; Secure
          </span>
        </header>

        <div
          className={`drop-zone ${dragging ? 'drop-zone--active' : ''} ${file ? 'drop-zone--filled' : ''}`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => !file && fileInputRef.current?.click()}
        >
          <svg
            className="drop-zone-svg-border"
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
          >
            <rect x="1" y="1" width="99%" height="99%" rx="11" ry="11" />
          </svg>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
          {file ? (
            <div className="file-info">
              <span className="file-icon">🎬</span>
              <span className="file-name">{file.name}</span>
              <span className="file-size">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
              <button
                className="file-clear"
                onClick={(e) => { e.stopPropagation(); setFile(null) }}
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="drop-prompt">
              <div className="drop-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
              <p>Drop a video file here</p>
              <span className="drop-sub">or click to browse</span>
            </div>
          )}
        </div>

        <div className="tier-section">
          <p className="tier-label">Hardware preset</p>
          <div className="tier-selector">
            <div
              className="tier-indicator"
              style={{ transform: `translateX(${selectedIdx * 100}%)` }}
            />
            {TIER_ORDER.map((tier) => (
              <button
                key={tier}
                className={`tier-btn ${hwTier === tier ? 'tier-btn--active' : ''}`}
                onClick={() => setHwTier(tier)}
              >
                {HW_TIER_LABELS[tier]}
              </button>
            ))}
          </div>

          {isCached ? (
            <p className="tier-hint tier-hint--cached">✓ Model cached — starts instantly</p>
          ) : (
            <div className="model-download-banner">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>
                Model auto-downloads on first run (~21.6 MB)
              </span>
            </div>
          )}
        </div>

        {/* Slowmo strength slider */}
        <div className="slowmo-section">
          <p className="tier-label">Slowmo strength</p>
          <div className="slowmo-row">
            <span className="slowmo-limit">Subtle</span>
            <input
              type="range"
              min="2"
              max="10"
              step="0.5"
              value={slowdownMultiplier}
              onChange={e => setSlowdownMultiplier(Number(e.target.value))}
              className="slowmo-slider"
              style={{ '--val': (slowdownMultiplier - 2) / 8 }}
            />
            <span className="slowmo-limit">Max</span>
          </div>
          <p className="tier-hint">
            {actualSlowdown}× slower — output will be ~{actualSlowdown}× longer
          </p>
        </div>

        <button
          className={`start-btn${isMorphing ? ' start-btn--morphing' : ''}`}
          disabled={!file || isMorphing}
          onClick={handleSubmit}
        >
          {!isMorphing && `Generate ${actualSlowdown}× Slowmo`}
        </button>
      </div>

        {cachedModels.length > 0 && (
          <div className="cache-manager">
            <button
              className="cache-toggle"
              onClick={() => setShowCacheManager(v => !v)}
            >
              {showCacheManager ? '▲' : '▼'} Cached models ({cachedModels.length})
            </button>
            {showCacheManager && (
              <ul className="cache-list">
                {cachedModels.map(key => (
                  <li key={key} className="cache-item">
                    <span className="cache-name">{key}</span>
                    <button
                      className="cache-delete"
                      onClick={() => handleDeleteModel(key)}
                      title={`Remove ${key} from browser cache`}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {typeof VideoDecoder === 'undefined' && (
          <p className="compat-warn">
            WebCodecs is not supported in this browser. Please use Chrome 94+ or Safari 17.2+.
          </p>
        )}
    </div>
  )
}
