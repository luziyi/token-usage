import { memo } from 'react'
const api = window.tokenUsage

const PERIOD_LABELS = { today: '今日', month: '本月', allTime: '总计' }

function TitleBar({ appInfo, connected, statusText, period, onSwitchPeriod }) {
  return (
    <header className="titlebar">
      <div className="title-left">
        <div className="app-title">
          <span className="app-title-icon" aria-hidden="true">&#9670;</span>
          <span className="app-title-text">Token Usage</span>
          <span className="app-version">
            {appInfo?.version ? 'v' + appInfo.version : ''}
          </span>
          <span
            className={'live-dot' + (connected ? '' : ' offline')}
            title="Status"
          />
        </div>
        <div className="status">{statusText}</div>
      </div>
      <div className="title-controls">
        <nav className="tabs" aria-label="时间周期">
          {Object.entries(PERIOD_LABELS).map(([key, label]) => (
            <button
              key={key}
              className={'tab' + (period === key ? ' active' : '')}
              data-period={key}
              onClick={() => onSwitchPeriod(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="window-actions">
          <button className="icon-button" aria-label="最小化" onClick={() => api.minimize()}>&#8722;</button>
          <button className="icon-button" aria-label="关闭" onClick={() => api.close()}>&#10005;</button>
        </div>
      </div>
    </header>
  )
}

export default memo(TitleBar)
