import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
const URLS = {
  unifiedChat: API_BASE ? `${API_BASE}/api/unified/chat` : '/api/unified/chat',
  portfolioIndex: API_BASE ? `${API_BASE}/api/index` : '/api/index',
  portfolioCollection: API_BASE ? `${API_BASE}/api/collection` : '/api/collection',
  transcriptIndex: API_BASE ? `${API_BASE}/api/transcript/index` : '/api/transcript/index',
  transcriptCollection: API_BASE ? `${API_BASE}/api/transcript/collection` : '/api/transcript/collection',
}

const THEME_KEY = 'rag-theme'

export default function App() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [indexing, setIndexing] = useState(false)
  const [indexResult, setIndexResult] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark')
  const [portfolioCollection, setPortfolioCollection] = useState(null)
  const [transcriptCollection, setTranscriptCollection] = useState(null)
  const [collectionLoading, setCollectionLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [activeUploadType, setActiveUploadType] = useState(null)
  const bottomRef = useRef(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const fetchCollections = useCallback(async () => {
    setCollectionLoading(true)
    try {
      const [pRes, tRes] = await Promise.all([
        fetch(URLS.portfolioCollection),
        fetch(URLS.transcriptCollection),
      ])
      setPortfolioCollection(pRes.ok ? await pRes.json() : null)
      setTranscriptCollection(tRes.ok ? await tRes.json() : null)
    } catch (_) {
      setPortfolioCollection(null)
      setTranscriptCollection(null)
    } finally {
      setCollectionLoading(false)
    }
  }, [])

  useEffect(() => {
    setMessages([{
      role: 'assistant',
      content: 'Hi, upload both Portfolio PDF and Transcript files, then ask me to create tasks. I will tag each task with the best portfolio match and alternatives.',
    }])
    fetchCollections()
  }, [fetchCollections])

  async function handleSubmit(e) {
    e.preventDefault()
    const question = input.trim()
    if (!question || loading) return

    setInput('')
    setMessages((m) => [...m, { role: 'user', content: question }])
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(URLS.unifiedChat, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, mode: activeUploadType }),
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
      const tasks = Array.isArray(data.tasks) ? data.tasks : []
      setMessages((m) => [...m, { role: 'assistant', content: answerText, recommendation, tasks }])
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

  async function doIndex(body, type) {
    setIndexing(true)
    setIndexResult(null)
    setError(null)
    try {
      const endpoint = type === 'portfolio' ? URLS.portfolioIndex : URLS.transcriptIndex
      const res = await fetch(endpoint, {
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
      const cleanNames = (data.sources || []).map(s => s.replace(/^upload-\d+-[a-z0-9]+-/, ''))
      setIndexResult({
        success,
        message: success
          ? `${type === 'portfolio' ? 'Portfolio' : 'Transcript'}: ${cleanNames.join(', ')} indexed successfully.`
          : (data.message || 'Indexing failed.'),
      })
      fetchCollections()
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

  async function handleIndex(e, type) {
    const files = e?.target?.files
    if (!files?.length) return
    setActiveUploadType(type)
    const list = Array.from(files)
    const nonValid = list.find((f) => {
      if (type === 'portfolio') {
        return f.type !== 'application/pdf'
      } else {
        return f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.docx') && f.type !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }
    })
    
    if (nonValid) {
      setIndexResult({ success: false, message: type === 'portfolio' ? 'Please select only PDF files.' : 'Please select only PDF or DOCX files.' })
      e.target.value = ''
      return
    }
    const formData = new FormData()
    for (const f of list) formData.append('pdf', f)
    await doIndex(formData, type)
    e.target.value = ''
  }

  async function handleDeleteCollection(type) {
    if (!confirm('Delete the entire indexed collection? This cannot be undone.')) return
    setDeleting(true)
    setIndexResult(null)
    try {
      const endpoint = type === 'portfolio' ? URLS.portfolioCollection : URLS.transcriptCollection
      const res = await fetch(endpoint, { method: 'DELETE' })
      const data = await res.json()
      setIndexResult({ success: data.success, message: data.message })
      fetchCollections()
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
            <h1>Unified RAG Workspace</h1>
            <p className="subtitle">Upload portfolio and transcript files separately, then create tagged tasks from both datasets.</p>
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
            <label
              className={`btn ${activeUploadType === 'portfolio' ? 'btn-primary' : 'btn-secondary'} ${busy ? 'disabled' : ''}`}
              onClick={() => setActiveUploadType('portfolio')}
            >
              <input
                type="file"
                accept="application/pdf"
                multiple
                onChange={(e) => handleIndex(e, 'portfolio')}
                disabled={busy}
                style={{ display: 'none' }}
              />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {indexing ? 'Indexing...' : 'Upload Portfolio PDF'}
            </label>
            <label
              className={`btn ${activeUploadType === 'transcript' ? 'btn-primary' : 'btn-secondary'} ${busy ? 'disabled' : ''}`}
              onClick={() => setActiveUploadType('transcript')}
            >
              <input
                type="file"
                accept="application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                multiple
                onChange={(e) => handleIndex(e, 'transcript')}
                disabled={busy}
                style={{ display: 'none' }}
              />
              Upload Transcript (PDF/Word)
            </label>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => handleDeleteCollection('portfolio')}
              disabled={deleting}
              title="Delete portfolio collection"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              {deleting ? 'Deleting...' : 'Delete Portfolio'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => handleDeleteCollection('transcript')}
              disabled={deleting}
              title="Delete transcript collection"
            >
              {deleting ? 'Deleting...' : 'Delete Transcript'}
            </button>
          </div>
        </div>

        <div className={`collection-status ${collectionLoading ? 'collection-loading' : (portfolioCollection?.exists || transcriptCollection?.exists) ? 'collection-active' : 'collection-empty'}`}>
          <div className="collection-dot" />
          {collectionLoading ? (
            <span className="collection-label">Checking collection status...</span>
          ) : (
            <div className="collection-info">
              <span className="collection-label">Portfolio: {portfolioCollection?.exists ? 'Indexed' : 'Not Indexed'} | Transcript: {transcriptCollection?.exists ? 'Indexed' : 'Not Indexed'}</span>
              <span className="collection-detail">Portfolio chunks: {portfolioCollection?.points ?? 0}, Transcript chunks: {transcriptCollection?.points ?? 0}</span>
            </div>
          )}
        </div>

        {indexResult && (
          <div className={`alert ${indexResult.success ? 'alert-success' : 'alert-error'}`}>
            {indexResult.message}
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
              <p>Ask for summary, action items, or create tasks mapped to portfolio tags.</p>
              <div className="empty-examples">
                <span>"Create tasks from this transcript and tag to portfolio"</span>
                <span>"Show alternatives for each task tag"</span>
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`message message--${msg.role}${msg.tasks?.length ? ' message--task-cards' : ''}`}>
              <div className="message-avatar">
                {msg.role === 'user' ? 'U' : 'AI'}
              </div>
              <div className="message-body">
                <div className="message-content">
                  {msg.error ? (
                    <p className="message-error">{msg.error}</p>
                  ) : (
                    <>
                      {msg.recommendation?.best_match && !msg.tasks?.length && (
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
                      {msg.tasks?.length > 0 ? (
                        <div className="task-cards">
                          {msg.tasks.map((task, idx) => (
                            <div className="task-card" key={`${task.title}-${idx}`}>
                              <div className="task-card-head">
                                <span className="task-card-index">Task {idx + 1}</span>
                                <h3>{task.title}</h3>
                              </div>
                              <p className="task-card-desc">{task.description}</p>

                              <div className="task-match-block">
                                <div className="task-label">Best Match</div>
                                <div className="task-match-pill">
                                  <strong>{task.best_match?.id ?? 'NO-MATCH'}</strong>
                                  <span>{task.best_match?.title ?? 'No suitable portfolio found'}</span>
                                </div>
                                {task.best_match?.reason ? (
                                  <div className="task-reason">{task.best_match.reason}</div>
                                ) : null}
                                {task.needs_new_portfolio ? (
                                  <div className="task-new-portfolio-note">
                                    No current portfolio is related to this task. Create a new portfolio tag.
                                    {task.new_portfolio_suggestion ? ` Suggested: ${task.new_portfolio_suggestion}` : ''}
                                  </div>
                                ) : null}
                              </div>

                              {task.alternatives?.length > 0 ? (
                                <div className="task-alt-block">
                                  <div className="task-label">Alternatives</div>
                                  <div className="task-alt-list">
                                    {task.alternatives.map((alt, j) => (
                                      <div className="task-alt-item" key={`${alt.id ?? 'alt'}-${j}`}>
                                        <span className="task-alt-id">{alt.id ?? 'N/A'}</span>
                                        <span className="task-alt-title">{alt.title ?? 'No title'}</span>
                                        {alt.reason ? <span className="task-alt-reason"> - {alt.reason}</span> : null}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                <div className="task-alt-block">
                                  <div className="task-label">Alternatives</div>
                                  <div className="task-no-alt">No close alternatives found.</div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="message-text">{msg.content}</div>
                      )}
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
              placeholder={indexing ? 'Indexing in progress, please wait...' : 'Ask anything, e.g. "Create tasks from transcript and tag portfolio with alternatives"'}
              disabled={loading || indexing}
              autoFocus
            />
            <button type="submit" disabled={loading || indexing || !input.trim()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
