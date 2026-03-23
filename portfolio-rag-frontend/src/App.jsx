import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
const API_URL = API_BASE ? `${API_BASE}/api/chat` : '/api/chat'
const INDEX_URL = API_BASE ? `${API_BASE}/api/index` : '/api/index'
const COLLECTION_URL = API_BASE ? `${API_BASE}/api/collection` : '/api/collection'
const THEME_KEY = 'rag-theme'

export default function App() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [indexing, setIndexing] = useState(false)
  const [indexResult, setIndexResult] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark')
  const [collection, setCollection] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [collectionLoading, setCollectionLoading] = useState(true)
  const bottomRef = useRef(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const timer = setTimeout(() => {
      setMessages([{
        role: 'assistant',
        content: 'Hi, I am your assistant for suggesting the best portfolio match for your task. Describe what you need and I will find the most relevant project for you!'
      }])
    }, 1000)
    return () => clearTimeout(timer)
  }, [])

  const fetchCollection = useCallback(async () => {
    setCollectionLoading(true)
    try {
      const res = await fetch(COLLECTION_URL)
      if (res.ok) {
        const data = await res.json()
        setCollection(data)
      }
    } catch (_) {}
    setCollectionLoading(false)
  }, [])

  useEffect(() => {
    fetchCollection()
  }, [fetchCollection])

  async function handleSubmit(e) {
    e.preventDefault()
    const question = input.trim()
    if (!question || loading) return

    setInput('')
    setMessages((m) => [...m, { role: 'user', content: question }])
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      })
      const text = await res.text()
      let data = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        const msg = !res.ok && res.status >= 502
          ? "Server not reachable."
          : (text || `Request failed: ${res.status}`)
        throw new Error(res.ok ? 'Invalid response from server' : msg)
      }
      if (!res.ok) {
        throw new Error(data.error || `Request failed: ${res.status}`)
      }
      const answerText = data.answer != null ? String(data.answer) : ""
      const recommendation = data.recommendation ?? null
      setMessages((m) => [...m, { role: 'assistant', content: answerText, recommendation }])
    } catch (err) {
      let msg = err?.message || 'Request failed'
      if (msg === 'Failed to fetch' || msg.includes('NetworkError')) {
        msg = 'Cannot reach server. Make sure the backend is running.'
      }
      setError(msg)
      setMessages((m) => [...m, { role: 'assistant', content: null, error: msg }])
    } finally {
      setLoading(false)
    }
  }

  async function doIndex(body) {
    setIndexing(true)
    setIndexResult(null)
    setError(null)
    try {
      const res = await fetch(INDEX_URL, {
        method: 'POST',
        ...(body ? { body } : {}),
      })
      const text = await res.text()
      let data = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        setIndexResult({ success: false, message: text?.slice(0, 200) || `Request failed: ${res.status}` })
        return
      }
      if (!res.ok) {
        setIndexResult({ success: false, message: data.message || data.error || `Request failed: ${res.status}` })
        return
      }
      const success = data.success !== false
      setIndexResult({
        success,
        message: data.message || (success ? 'Indexing completed.' : 'Indexing failed.'),
        chunks: data.chunks,
        pdfCount: data.pdfCount,
        sources: data.sources,
        mode: data.mode,
      })
      fetchCollection()
    } catch (err) {
      let msg = err?.message || 'Indexing failed'
      if (msg === 'Failed to fetch' || msg.includes('NetworkError')) {
        msg = 'Cannot reach API. Make sure the backend is running.'
      }
      setIndexResult({ success: false, message: msg })
    } finally {
      setIndexing(false)
    }
  }

  async function handleIndex(e) {
    const files = e?.target?.files
    if (!files?.length) return
    const list = Array.from(files)
    const nonPdf = list.find((f) => f.type !== 'application/pdf')
    if (nonPdf) {
      setIndexResult({ success: false, message: 'Please select only PDF files.' })
      e.target.value = ''
      return
    }
    const formData = new FormData()
    for (const f of list) formData.append('pdf', f)
    await doIndex(formData)
    e.target.value = ''
  }

  async function handleDeleteCollection() {
    if (!confirm('Delete the entire indexed collection? This cannot be undone.')) return
    setDeleting(true)
    setIndexResult(null)
    try {
      const res = await fetch(COLLECTION_URL, { method: 'DELETE' })
      const data = await res.json()
      setIndexResult({ success: data.success, message: data.message })
      fetchCollection()
    } catch (err) {
      setIndexResult({ success: false, message: err?.message || 'Delete failed' })
    } finally {
      setDeleting(false)
    }
  }

  const busy = loading || indexing || deleting

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <div className="brand">
            <h1>Portfolio RAG</h1>
            <p className="subtitle">AI-powered project recommender from your indexed portfolio data</p>
          </div>
          <button
            type="button"
            className="btn-icon btn-theme"
            onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
            title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {theme === 'light' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
          </button>
        </div>

        <div className="toolbar">
          <div className="toolbar-actions">
            <label className={`btn btn-primary ${busy ? 'disabled' : ''}`}>
              <input
                type="file"
                accept="application/pdf"
                multiple
                onChange={handleIndex}
                disabled={busy}
                style={{ display: 'none' }}
              />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {indexing ? 'Indexing...' : 'Upload PDF'}
            </label>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => doIndex()}
              disabled={busy}
              title="Index default protfolioData.pdf from server"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              Index Default
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleDeleteCollection}
              disabled={deleting}
              title="Delete entire Qdrant collection"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              {deleting ? 'Deleting...' : 'Delete Collection'}
            </button>
          </div>
        </div>

        <div className={`collection-status ${collectionLoading ? 'collection-loading' : collection?.exists ? 'collection-active' : 'collection-empty'}`}>
          <div className="collection-dot" />
          {collectionLoading ? (
            <span className="collection-label">Checking collection status...</span>
          ) : collection?.exists ? (
            <div className="collection-info">
              <span className="collection-label">Indexed</span>
              <span className="collection-detail">
                {collection.points} chunks
                {collection.sources?.length > 0 && (
                  <> from <strong>{collection.sources.join(', ')}</strong></>
                )}
              </span>
            </div>
          ) : (
            <span className="collection-label">No data indexed yet. Upload a PDF or click Index Default to get started.</span>
          )}
        </div>

        {indexResult && (
          <div className={`alert ${indexResult.success ? 'alert-success' : 'alert-error'}`}>
            {indexResult.message}
            {indexResult.chunks != null && ` (${indexResult.chunks} chunks)`}
            {indexResult.success && indexResult.sources?.length > 0 && (
              <span className="alert-detail"> — {indexResult.sources.join(', ')}</span>
            )}
            <button className="alert-close" onClick={() => setIndexResult(null)}>&times;</button>
          </div>
        )}
      </header>

      <main className="main">
        <div className="messages">
          {messages.length === 0 && !loading && (
            <div className="empty">
              <div className="empty-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <p>Ask me anything about your portfolio projects</p>
              <div className="empty-examples">
                <span>"What projects are in the portfolio?"</span>
                <span>"Summarize my experience"</span>
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`message message--${msg.role}`}>
              <div className="message-avatar">
                {msg.role === 'user' ? 'U' : 'AI'}
              </div>
              <div className="message-body">
                <div className="message-content">
                  {msg.error ? (
                    <p className="message-error">{msg.error}</p>
                  ) : (
                    <>
                      {msg.recommendation?.best_match && (
                        <div className="recommendation-card">
                          <div className="rec-header">Best Match</div>
                          <div className="rec-item">
                            <span className="rec-id">{msg.recommendation.best_match.id ?? '—'}</span>
                            <span className="rec-title">{msg.recommendation.best_match.title ?? '—'}</span>
                          </div>
                          {msg.recommendation.best_match.reason && (
                            <p className="rec-reason">{msg.recommendation.best_match.reason}</p>
                          )}
                          {msg.recommendation.alternatives?.length > 0 && (
                            <div className="rec-alternatives">
                              <span className="rec-alt-label">Alternatives:</span>
                              {msg.recommendation.alternatives.map((id, j) => (
                                <span key={j} className="rec-alt-tag">{id}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="message-text">{msg.content}</div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
          {loading && (
            <div className="message message--assistant">
              <div className="message-avatar">AI</div>
              <div className="message-body">
                <div className="message-content typing">
                  <span /><span /><span />
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <form className="form" onSubmit={handleSubmit}>
          {error && <p className="form-error">{error}</p>}
          <div className="form-row">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe a task or ask a question..."
              disabled={loading}
              autoFocus
            />
            <button type="submit" disabled={loading || !input.trim()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
