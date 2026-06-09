import { useState, useEffect, useCallback } from 'react'
import TitleBar from './TitleBar'
import TotalPanel from './TotalPanel'
import SettingsPanel from './SettingsPanel'
import BreakdownPanel from './BreakdownPanel'
import SessionDetail from './SessionDetail'

const api = window.tokenUsage

export const BREAKDOWN_MODES = [
  { key: 'model', label: '模型' },
  { key: 'date', label: '日期' },
  { key: 'agent', label: '代理' },
  { key: 'session', label: '会话' },
]

export const MODEL_ICONS = {
  deepseek: 'deepseek.svg',
  'deepseek-v4-flash': 'deepseek.svg',
  'deepseek-v4-pro': 'deepseek.svg',
  'deepseek-chat': 'deepseek.svg',
  'deepseek-reasoner': 'deepseek.svg',
  claude: 'claude.svg',
  'claude-code': 'claude.svg',
  'claude-sonnet-4': 'claude.svg',
  'claude-opus-4': 'claude.svg',
  'gpt-4o': 'openai.svg',
  openai: 'openai.svg',
  opencode: 'opencode.png',
  qwen: 'qwen.svg',
  'alibaba-cn': 'qwen.svg',
  minimax: 'minimax.svg',
  gemini: 'gemini.svg',
  google: 'google.svg',
  anthropic: 'anthropic.svg',
  openrouter: 'anthropic.svg',
  meta: 'meta.svg',
  default: null,
}

const MODEL_COLORS = {
  deepseek: '#4fc3f7',
  'deepseek-v4-flash': '#4fc3f7',
  'deepseek-v4-pro': '#4fc3f7',
  'deepseek-chat': '#4fc3f7',
  'deepseek-reasoner': '#ff8a65',
  claude: '#ce93d8',
  'claude-sonnet-4': '#ce93d8',
  'claude-opus-4': '#ef5350',
  'gpt-4o': '#66bb6a',
  openai: '#66bb6a',
  qwen: '#6fa8dc',
  minimax: '#f4a073',
  gemini: '#f1d973',
  google: '#f1d973',
  anthropic: '#ce93d8',
  meta: '#4fc3f7',
  default: '#6c9ef0',
}

const ICON_COLORS = {
  'icons/deepseek.svg': '#4D6BFE',
  'icons/claude.svg': '#D97757',
  'icons/openai.svg': '#66bb6a',
  'icons/opencode.png': '#a6a6a6',
  'icons/qwen.svg': '#6336E7',
  'icons/minimax.svg': '#E2167E',
  'icons/gemini.svg': '#3186FF',
  'icons/google.svg': '#4285F4',
  'icons/anthropic.svg': '#ce93d8',
  'icons/meta.svg': '#0082FB',
}

export function formatNumber(n) { return String(n) }

export function formatNumberWithCommas(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatCost(costUsd, currency) {
  const c = currency || 'USD'
  if (costUsd < 0.001) return '<$0.01'
  if (c === 'CNY') return '¥' + (costUsd * 7.2).toFixed(2)
  return '$' + costUsd.toFixed(3)
}

export function pad2(v) {
  return String(v).padStart(2, '0')
}

export function compactTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate())
}

export function formatDateWeekday(dateKey) {
  const days = ['日', '一', '二', '三', '四', '五', '六']
  if (!dateKey || dateKey === 'unknown') return ''
  const d = new Date(dateKey)
  if (isNaN(d.getTime())) return dateKey
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + days[d.getDay()]
}

export function formatSessionTitle(title, fallback) {
  if (title && title.length > 40) return title.substring(0, 40) + '…'
  return title || fallback || '(无标题)'
}

export function modelIconSrc(modelId, provider, modelKey) {
  const id = (modelId || '').toLowerCase()
  const prov = (provider || '').toLowerCase()
  const mk = (modelKey || '').toLowerCase()
  if (MODEL_ICONS[mk]) return 'icons/' + MODEL_ICONS[mk]
  if (MODEL_ICONS[id]) return 'icons/' + MODEL_ICONS[id]
  for (const [key, val] of Object.entries(MODEL_ICONS)) {
    if (mk.includes(key) || id.includes(key)) return 'icons/' + val
  }
  if (MODEL_ICONS[prov]) return 'icons/' + MODEL_ICONS[prov]
  for (const [key, val] of Object.entries(MODEL_ICONS)) {
    if (prov.includes(key)) return 'icons/' + val
  }
  return null
}

export function modelColor(modelId, provider, modelKey, accentColor) {
  const iconPath = modelIconSrc(modelId, provider, modelKey)
  if (iconPath && ICON_COLORS[iconPath]) return ICON_COLORS[iconPath]
  const accent = accentColor || MODEL_COLORS.default
  if (!modelId) return accent
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (modelId.toLowerCase().includes(key)) return color
  }
  return accent
}

export function sourceColor(source, accentColor) {
  const iconPath = source === 'opencode' ? 'icons/opencode.png' : source === 'claude-code' ? 'icons/claude.svg' : null
  if (iconPath && ICON_COLORS[iconPath]) return ICON_COLORS[iconPath]
  return source === 'opencode' ? '#4fc3f7' : (source === 'claude-code' || source === 'claude') ? '#ce93d8' : (accentColor || '#6c9ef0')
}

export function agentLabel(source) {
  if (source === 'opencode') return 'OpenCode'
  if (source === 'claude-code') return 'Claude Code'
  return source
}

export function agentIcon(source) {
  if (source === 'opencode') return 'icons/opencode.png'
  if (source === 'claude-code') return 'icons/claude.svg'
  return null
}

export function getProviderLabel(modelId) {
  if (!modelId) return ''
  const id = modelId.toLowerCase()
  if (id.includes('deepseek')) return 'DeepSeek'
  if (id.includes('claude') || id.includes('anthropic')) return 'Anthropic'
  if (id.includes('gpt') || id.includes('o3') || id.includes('o4')) return 'OpenAI'
  if (id.includes('gemini')) return 'Google'
  if (id.includes('qwen')) return 'Qwen'
  return ''
}

export function cleanModelName(raw) {
  if (!raw) return ''
  let name = String(raw)
  name = name.replace(/^openrouter\//i, '')
  const parts = name.split('/')
  return parts[parts.length - 1] || name
}

export function effectiveProvider(raw) {
  if (!raw) return ''
  const id = String(raw).toLowerCase()
  if (id.startsWith('openrouter/')) {
    const rest = id.replace(/^openrouter\//, '')
    const parts = rest.split('/')
    if (parts.length > 1) return getProviderLabel(parts[0]) || parts[0]
  }
  return ''
}

export function useAnimatedNumber(target) {
  const [display, setDisplay] = useState(target)
  useEffect(() => {
    const prev = (() => {
      try { return parseInt(String(display).replace(/,/g, ''), 10) || 0 } catch { return 0 }
    })()
    if (prev === target) {
      setDisplay(target)
      return
    }
    const duration = 1200
    const start = performance.now()
    let raf
    const step = (timestamp) => {
      const progress = Math.min((timestamp - start) / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      const currentVal = Math.round(prev + (target - prev) * eased)
      setDisplay(currentVal)
      if (progress < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => { if (raf) cancelAnimationFrame(raf) }
  }, [target])
  return display
}

export default function App() {
  const [period, setPeriod] = useState('today')
  const [breakdown, setBreakdown] = useState('model')
  const [settings, setSettings] = useState(null)
  const [data, setData] = useState(null)
  const [appInfo, setAppInfo] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionDetail, setSessionDetail] = useState(null)
  const [connected, setConnected] = useState(false)
  const [statusText, setStatusText] = useState('初始化中...')

  useEffect(() => {
    api.getAppInfo().then(info => setAppInfo(info))
    api.getSettings().then(s => {
      setSettings(s)
      setStatusText('就绪')
      return api.getData()
    }).then(d => {
      if (d) setData(d)
    })
  }, [])

  useEffect(() => {
    const unsubData = api.onDataPush(payload => {
      if (payload.error) {
        setStatusText('错误: ' + payload.error)
        setConnected(false)
        return
      }
      setData(payload.data)
      if (payload.settings) setSettings(payload.settings)
      setConnected(true)
      setStatusText('更新于 ' + new Date(payload.at).toLocaleTimeString())
      if (sessionDetail && !sessionDetail.loading && sessionDetail.sessionId) {
        api.getSessionDetail({ sessionId: sessionDetail.sessionId }).then(r => {
          if (!r) return
          setSessionDetail(prev => ({ ...prev, ...r, loading: false }))
        })
      }
    })
    const unsubSettings = api.onSettingsPush(s => setSettings(s))
    return () => { unsubData(); unsubSettings() }
  }, [sessionDetail])

  useEffect(() => {
    if (settings?.accentColor) {
      document.documentElement.style.setProperty('--accent', settings.accentColor)
    }
  }, [settings?.accentColor])

  const handleRefresh = useCallback(() => {
    api.refreshData().then(d => { if (d) setData(d) })
  }, [])

  const handleSaveSettings = useCallback((patch) => {
    api.updateSettings(patch).then(s => {
      setSettings(s)
      setSettingsOpen(false)
    })
  }, [])

  const handleOpenSessionDetail = useCallback((sessionId) => {
    setSessionDetail({ sessionId, loading: true })
    api.getSessionDetail({ sessionId }).then(result => {
      setSessionDetail(prev => ({ ...prev, ...result, loading: false }))
    }).catch(() => {
      setSessionDetail(prev => ({ ...prev, loading: false, error: true }))
    })
  }, [])

  const handleCloseSessionDetail = useCallback(() => {
    setSessionDetail(null)
  }, [])

  const handleSwitchPeriod = useCallback((p) => {
    setPeriod(p)
    setSessionDetail(null)
  }, [])

  const handleSwitchBreakdown = useCallback((mode) => {
    setBreakdown(mode)
    setSessionDetail(null)
  }, [])

  return (
    <>
      <TitleBar
        appInfo={appInfo}
        connected={connected}
        statusText={statusText}
        period={period}
        onSwitchPeriod={handleSwitchPeriod}
      />
      <TotalPanel
        data={data}
        period={period}
        settings={settings}
        breakdown={breakdown}
        onSwitchBreakdown={handleSwitchBreakdown}
        onRefresh={handleRefresh}
        onToggleSettings={() => setSettingsOpen(o => !o)}
      />
      {settingsOpen && settings && (
        <SettingsPanel
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {sessionDetail ? (
        <SessionDetail
          detail={sessionDetail}
          onClose={handleCloseSessionDetail}
          settings={settings}
        />
      ) : (
        <BreakdownPanel
          data={data}
          period={period}
          breakdown={breakdown}
          settings={settings}
          onOpenSessionDetail={handleOpenSessionDetail}
        />
      )}
    </>
  )
}
