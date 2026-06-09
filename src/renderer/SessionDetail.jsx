import { memo, useMemo, useRef, useEffect, useState, useCallback } from 'react'
import {
  formatNumberWithCommas,
  formatNumber,
  formatCost,
  compactTime,
} from './App'

function SessionDetail({ detail, onClose, settings }) {
  const scrollRef = useRef(null)
  const scrollPosRef = useRef(0)
  const currency = (settings && settings.currency) || 'USD'

  const { loading, error, found, exchanges, summary } = detail || {}

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollPosRef.current
    }
  })

  function handleScroll() {
    if (scrollRef.current) {
      scrollPosRef.current = scrollRef.current.scrollTop
    }
  }

  const sorted = useMemo(() => {
    if (!exchanges) return []
    return [...exchanges]
      .filter(ex => (ex.tokens?.total || 0) > 0)
      .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''))
  }, [exchanges])

  const maxValue = useMemo(() =>
    Math.max(1, ...sorted.map(r => r.tokens?.total || 0)),
    [sorted]
  )

  if (!detail) return null

  return (
    <section className="session-detail" ref={scrollRef} onScroll={handleScroll}>
      <div className="detail-header">
        <button className="detail-back" onClick={onClose}>&#8249; 返回</button>
        <span className="detail-info">
          {loading ? '加载中…' : (exchanges ? exchanges.length + ' 轮对话' : '')}
        </span>
      </div>

      {loading && <EmptyNote text="加载中…" />}
      {!loading && (error || found === false) && <EmptyNote text="未找到会话详情" />}
      {!loading && !error && found !== false && sorted.length === 0 && <EmptyNote text="此会话无对话记录" />}

      {sorted.map((ex, i) => (
        <ExchangeNode
          key={i}
          exchange={ex}
          maxValue={maxValue}
          currency={currency}
        />
      ))}
    </section>
  )
}

function EmptyNote({ text }) {
  return (
    <div className="empty-state">
      <div className="empty-state-text">{text}</div>
    </div>
  )
}

const ExchangeNode = memo(function ExchangeNode({ exchange, maxValue, currency }) {
  const [expanded, setExpanded] = useState(false)
  const hasTurns = exchange.turns && exchange.turns.length > 0

  const pct = Math.max(2, Math.min(100, ((exchange.tokens?.total || 0) / maxValue) * 100))

  const subParts = [
    exchange.startedAt ? compactTime(exchange.startedAt) : '',
    exchange.modelName || '',
    exchange.turnCount ? exchange.turnCount + ' 次回复' : '',
  ].filter(Boolean)

  return (
    <div className="detail-exchange">
      <div className="detail-ex-head" onClick={() => hasTurns && setExpanded(!expanded)}>
        <span className={'detail-chev' + (hasTurns ? '' : ' hidden')}>
          {expanded ? '\u25be' : '\u25b8'}
        </span>
        <div className="detail-ex-label">
          <div className="detail-ex-title">
            {exchange.promptPreview ? (
              <><span className="detail-role-user">You &#8250; </span>{exchange.promptPreview}</>
            ) : exchange.modelName ? (
              <><span className="detail-role-ai">AI &#8250; </span>{exchange.modelName}</>
            ) : (
              'AI 回复'
            )}
          </div>
          <div className="detail-ex-sub">{subParts.join(' · ')}</div>
        </div>
        <div className="detail-ex-metrics">
          <span className="detail-ex-value">{formatNumber(exchange.tokens?.total || 0)}</span>
          <span className="detail-ex-cost">{formatCost(exchange.costEstimate || 0, currency)}</span>
        </div>
      </div>
      <div className="bar"><div className="bar-fill" style={{ width: pct + '%' }} /></div>
      {expanded && hasTurns && (
        <div className="detail-turns">
          {exchange.turns.map((turn, i) => (
            <TurnNode key={i} turn={turn} index={i} currency={currency} />
          ))}
        </div>
      )}
    </div>
  )
})

const TurnNode = memo(function TurnNode({ turn, index, currency }) {
  const tk = turn.tokens || {}
  const cache = (tk.cacheRead || 0) + (tk.cacheWrite || 0)
  const split = 'IN ' + formatNumber(tk.input || 0) + ' · OUT ' + formatNumber(tk.output || 0) + ' · CACHE ' + formatNumber(cache) + (tk.reasoning ? ' · REASON ' + formatNumber(tk.reasoning) : '')

  return (
    <div className="detail-turn">
      <div className="detail-turn-label">
        <span className="detail-turn-title">AI 回复 #{index + 1}</span>
        <span className="detail-turn-split">{split}</span>
      </div>
      <div className="detail-turn-metrics">
        <span className="detail-turn-value">{formatNumber(tk.total || 0)}</span>
        <span className="detail-turn-cost">{formatCost(turn.costEstimate || 0, currency)}</span>
      </div>
    </div>
  )
})

export default memo(SessionDetail)
