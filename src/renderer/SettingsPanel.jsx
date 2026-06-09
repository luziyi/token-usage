import { memo, useState, useEffect } from 'react'

const COLORS = [
  { color: '#5e9eff', title: '默认蓝' },
  { color: '#9d80e8', title: '紫色' },
  { color: '#5dbe8a', title: '绿色' },
  { color: '#e8965a', title: '橙色' },
  { color: '#e8606a', title: '红色' },
  { color: '#4fc3f7', title: '青色' },
]

function SettingsPanel({ settings, onSave, onClose }) {
  const [currency, setCurrency] = useState(settings?.currency || 'USD')
  const [refreshMs, setRefreshMs] = useState(String(settings?.refreshMs || 5000))
  const [accentColor, setAccentColor] = useState(settings?.accentColor || '#5e9eff')

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accentColor)
  }, [accentColor])

  useEffect(() => {
    if (settings) {
      setCurrency(settings.currency || 'USD')
      setRefreshMs(String(settings.refreshMs || 5000))
      setAccentColor(settings.accentColor || '#5e9eff')
    }
  }, [settings])

  function handleSave() {
    onSave({
      currency,
      refreshMs: parseInt(refreshMs, 10),
      accentColor,
    })
  }

  return (
    <section className="settings-panel">
      <div className="settings-panel-title">
        <span>偏好设置</span>
        <span className="settings-panel-sub">币种、主题与刷新频率</span>
      </div>
      <div className="settings-fields">
        <div className="settings-field">
          <div className="settings-field-label">币种</div>
          <div className="settings-select-wrap">
            <select value={currency} onChange={e => setCurrency(e.target.value)}>
              <option value="USD">USD ($)</option>
              <option value="CNY">CNY (¥)</option>
            </select>
            <span className="settings-select-arrow">&#9660;</span>
          </div>
        </div>
        <div className="settings-field">
          <div className="settings-field-label">刷新间隔</div>
          <div className="settings-select-wrap">
            <select value={refreshMs} onChange={e => setRefreshMs(e.target.value)}>
              <option value="2000">2 秒</option>
              <option value="5000">5 秒</option>
              <option value="10000">10 秒</option>
              <option value="30000">30 秒</option>
              <option value="60000">60 秒</option>
            </select>
            <span className="settings-select-arrow">&#9660;</span>
          </div>
        </div>
        <div className="settings-field">
          <div className="settings-field-label">主题色</div>
          <div className="color-swatches">
            {COLORS.map(({ color, title }) => (
              <button
                key={color}
                className={'color-swatch' + (accentColor === color ? ' active' : '')}
                style={{ background: color }}
                title={title}
                onClick={() => setAccentColor(color)}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="settings-actions">
        <button onClick={handleSave}>保存</button>
      </div>
    </section>
  )
}

export default memo(SettingsPanel)
