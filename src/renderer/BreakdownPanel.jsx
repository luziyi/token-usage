import { memo, useMemo, useRef, useEffect } from 'react'
import {
  BREAKDOWN_MODES,
  formatNumberWithCommas,
  formatNumber,
  formatCost,
  formatDateWeekday,
  formatSessionTitle,
  compactTime,
  cleanModelName,
  effectiveProvider,
  getProviderLabel,
  modelColor,
  sourceColor,
  agentLabel,
  agentIcon,
  modelIconSrc,
} from './App'

function BreakdownPanel({ data, period, breakdown, settings, onOpenSessionDetail }) {
  const scrollRef = useRef(null)
  const scrollPosRef = useRef(0)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollPosRef.current
    }
  })

  const currency = (settings && settings.currency) || 'USD'
  const cnyRate = (settings && settings.cnyRate) || 7.2
  const accentColor = settings && settings.accentColor

  const periodData = data ? data[period] : null
  const aggregated = periodData ? periodData.aggregated : null

  const groups = useMemo(() => {
    if (!aggregated) return []

    let result = []

    if (breakdown === 'model') {
      const ds = aggregated.byModel
      result = Object.entries(ds).map(([key, d]) => ({
        key,
        modelKey: cleanModelName(key),
        provider: d.provider,
        label: cleanModelName(key),
        sublabel: effectiveProvider(key) || d.provider || getProviderLabel(key),
        tokens: d.input + d.output + d.cacheRead + d.cacheWrite + d.reasoning,
        cost: d.cost,
        detail: `IN ${d.input} · OUT ${d.output} · CACHE ${d.cacheRead + d.cacheWrite}`,
        color: modelColor(key, d.provider, cleanModelName(key), accentColor),
        sessionId: null,
      }))
    } else if (breakdown === 'date') {
      const ds = aggregated.byDate
      result = Object.entries(ds)
        .filter(([k]) => k !== 'unknown')
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([key, d]) => ({
          key,
          label: formatDateWeekday(key),
          sublabel: '',
          tokens: d.input + d.output + d.cacheRead + d.cacheWrite + d.reasoning,
          cost: d.cost,
          detail: `${d.count} 个会话`,
          color: accentColor || '#6c9ef0',
          sessionId: null,
        }))
    } else if (breakdown === 'agent') {
      const ds = aggregated.byAgent || {}
      result = Object.entries(ds).map(([key, d]) => ({
        key,
        source: d.source,
        label: agentLabel(key),
        sublabel: d.model || '',
        tokens: d.input + d.output + d.cacheRead + d.cacheWrite + d.reasoning,
        cost: d.cost,
        detail: `IN ${d.input} · OUT ${d.output} · CACHE ${d.cacheRead + d.cacheWrite}`,
        color: sourceColor(d.source || key, accentColor),
        sessionId: null,
      }))
    } else if (breakdown === 'session') {
      const ds = aggregated.bySession
      result = Object.values(ds)
        .filter(s => s.input + s.output + s.cacheRead + s.cacheWrite + s.reasoning > 0)
        .sort((a, b) => (b.timeCreated || 0) - (a.timeCreated || 0))
        .slice(0, 100)
        .map(s => {
          const cacheTotal = s.cacheRead + s.cacheWrite
          const cacheRate = (s.input + s.cacheRead) > 0
            ? (s.cacheRead / (s.input + s.cacheRead) * 100).toFixed(0)
            : null
          return {
            key: s.sessionId,
            modelKey: s.model,
            provider: s.provider,
            source: s.source,
            label: formatSessionTitle(s.title, s.sessionId.substring(0, 16)),
            sublabel: compactTime(s.timestamp),
            tokens: s.input + s.output + cacheTotal + s.reasoning,
            cost: s.cost,
            detail: 'IN ' + formatNumber(s.input) + ' · OUT ' + formatNumber(s.output) + ' · CACHE ' + formatNumber(cacheTotal) + (cacheRate ? ' · 缓存 ' + cacheRate + '%' : ''),
            color: sourceColor(s.source, accentColor),
            sessionId: s.sessionId,
          }
        })
    }

    return result.sort((a, b) => b.tokens - a.tokens)
  }, [aggregated, breakdown, accentColor])

  const maxTokens = groups.length > 0 ? groups[0].tokens : 1
  const modeLabel = BREAKDOWN_MODES.find(m => m.key === breakdown)?.label || ''

  function handleScroll() {
    if (scrollRef.current) {
      scrollPosRef.current = scrollRef.current.scrollTop
    }
  }

  if (!aggregated) return null

  return (
    <section className="breakdown" ref={scrollRef} onScroll={handleScroll}>
      <div className="section-label">{modeLabel}</div>
      {groups.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">&#9632;</div>
          <div className="empty-state-text">暂无数据</div>
        </div>
      ) : (
        groups.map(g => (
          <BreakdownRow
            key={g.key}
            group={g}
            maxTokens={maxTokens}
            currency={currency}
            cnyRate={cnyRate}
            onOpen={onOpenSessionDetail}
          />
        ))
      )}
    </section>
  )
}

const BreakdownRow = memo(function BreakdownRow({ group, maxTokens, currency, cnyRate, onOpen }) {
  const pct = group.tokens / maxTokens
  const toolIcon = group.source ? agentIcon(group.source) : null
  const iconPath = toolIcon || modelIconSrc(group.key, group.provider, group.modelKey)
  const dotOrIcon = iconPath
    ? <img className="row-icon" src={iconPath} alt="" aria-hidden="true" />
    : <span className="row-dot" style={{ background: group.color }} />

  function handleClick() {
    if (group.sessionId) onOpen(group.sessionId)
  }

  return (
    <div
      className="row"
      data-session={group.sessionId || ''}
      data-key={group.key}
      onClick={handleClick}
      style={{ cursor: group.sessionId ? 'pointer' : undefined }}
    >
      <div className="row-head">
        <div className="row-name">
          {dotOrIcon}
          <span className="row-label">{group.label}</span>
          {group.sublabel ? <span className="row-sublabel">{group.sublabel}</span> : null}
        </div>
        <div className="row-metrics">
          <div className="row-tokens">{formatNumberWithCommas(group.tokens)}</div>
          <div className="row-cost">{formatCost(group.cost, currency, cnyRate)}</div>
        </div>
      </div>
      <div className="row-detail">{group.detail}</div>
      <div className="bar">
        <div className="bar-fill" style={{ width: Math.max(2, pct * 100) + '%', background: group.color }} />
      </div>
    </div>
  )
})

export default memo(BreakdownPanel)
