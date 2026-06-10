import { memo, useState, useRef, useEffect, useCallback } from 'react'
import {
  BREAKDOWN_MODES,
  formatNumberWithCommas,
  formatCost,
  useAnimatedNumber,
} from './App'

function TotalPanel({
  data,
  period,
  settings,
  breakdown,
  onSwitchBreakdown,
  onRefresh,
  onToggleSettings,
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const refreshIconRef = useRef(null)

  const periodData = data ? data[period] : null
  const aggregated = periodData ? periodData.aggregated : null
  const currency = (settings && settings.currency) || 'USD'

  const totalTokens = aggregated ? aggregated.totalTokens : 0
  const totalCost = aggregated ? aggregated.totalCost : 0
  const cnyRate = (settings && settings.cnyRate) || 7.2
  const totals = aggregated
    ? aggregated.totals
    : { totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0 }

  const animatedTokens = useAnimatedNumber(totalTokens)

  const currentLabel = BREAKDOWN_MODES.find(m => m.key === breakdown)?.label || '模型'

  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e) {
      if (!e.target.closest('.toggle-btn-wrap')) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [menuOpen])

  const handleRefreshClick = useCallback(() => {
    const icon = refreshIconRef.current
    if (icon) {
      icon.style.transform = 'rotate(360deg)'
      icon.style.transition = 'transform 0.4s ease'
    }
    onRefresh()
    setTimeout(() => {
      if (icon) {
        icon.style.transition = 'none'
        icon.style.transform = 'rotate(0deg)'
      }
    }, 400)
  }, [onRefresh])

  return (
    <section className="total-panel">
      <div className="total-header">
        <div className="toggle-btn-wrap" style={{ position: 'relative' }}>
          <button
            className="toggle-btn"
            aria-label="切换分组方式"
            onClick={() => setMenuOpen(o => !o)}
          >
            <span id="breakdownLabel">{currentLabel}</span>
            <span className="toggle-arrow" aria-hidden="true">&#9660;</span>
          </button>
          {menuOpen && (
            <div className="dropdown-menu" id="breakdownMenu">
              {BREAKDOWN_MODES.map(m => (
                <div
                  key={m.key}
                  className={'dropdown-item' + (m.key === breakdown ? ' active' : '')}
                  onClick={() => { onSwitchBreakdown(m.key); setMenuOpen(false) }}
                >
                  {m.label}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="total-header-right">
          <button className="icon-button-sm" aria-label="刷新" onClick={handleRefreshClick}>
            <span className="refresh-icon" ref={refreshIconRef}>&#8635;</span>
          </button>
          <button className="icon-button-sm" aria-label="设置" onClick={onToggleSettings}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
          </button>
        </div>
      </div>
      <div className="total-number" aria-live="polite">
        {formatNumberWithCommas(animatedTokens)}
      </div>
      <div className="cost">{formatCost(totalCost, currency, cnyRate)}</div>
      <div className="token-breakdown">
        <span>IN {totals.totalInput}</span>
        <span>OUT {totals.totalOutput}</span>
        <span>CACHE {totals.totalCacheRead + totals.totalCacheWrite}</span>
      </div>
    </section>
  )
}

export default memo(TotalPanel)
