import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

function getUrls(tab) {
  const prefix = tab === 'portfolio' ? '/api' : '/api/transcript'
  return {
    chat: API_BASE ? `${API_BASE}${prefix}/chat` : `${prefix}/chat`,
    index: API_BASE ? `${API_BASE}${prefix}/index` : `${prefix}/index`,
    collection: API_BASE ? `${API_BASE}${prefix}/collection` : `${prefix}/collection`,
    feedback: API_BASE ? `${API_BASE}${prefix}/feedback` : `${prefix}/feedback`,
  }
}

const THEME_KEY = 'rag-theme'

export default function App() {
  const [activeTab, setActiveTab] = useState('portfolio')
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

  const urls = getUrls(activeTab)

  const fetchCollection = useCallback(async () => {
    setCollectionLoading(true)
    try {
      const res = await fetch(urls.collection)
      if (res.ok) {
        const data = await res.json()
        setCollection(data)
      } else {
        setCollection(null)
      }
    } catch (_) {
      setCollection(null)
    }
    setCollectionLoading(false)
  }, [urls.collection])

  useEffect(() => {
    setMessages([])
    setCollection(null)
    setIndexResult(null)
    setError(null)

    const timer = setTimeout(() => {
      setMessages([{
        role: 'assistant',
        content: activeTab === 'portfolio' 
          ? 'Hi, I am your assistant for suggesting the best portfolio match for your task. Describe what you need and I will find the most relevant project for you!'
          : 'Hi, I am your Transcript AI assistant. Ask me to summarize or extract action items from your uploaded meetings!'
      }])
    }, 1000)

    fetchCollection()

    return () => clearTimeout(timer)
  }, [activeTab, fetchCollection])

  async function handleSubmit(e) {
    e.preventDefault()
    const question = input.trim()
    if (!question || loading) return

    setInput('')
    setMessages((m) => [...m, { role: 'user', content: question }])
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(urls.chat, {
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

  async function handleFeedback(messageIndex, isPositive, correction = null) {
    const msg = messages[messageIndex]
    const userMsg = messages[messageIndex - 1]
    
    if (!userMsg || userMsg.role !== 'user') return

    try {
      const res = await fetch(urls.feedback, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: userMsg.content,
          answer: msg.content,
          isPositive,
          correction
        }),
      })

      if (res.ok) {
        setMessages(prev => prev.map((m, idx) => 
          idx === messageIndex ? { ...m, feedbackSent: true, feedbackPositive: isPositive } : m
        ))
      }
    } catch (err) {
      console.error('Feedback error:', err)
    }
  }

  async function doIndex(body) {
    setIndexing(true)
    setIndexResult(null)
    setError(null)
    try {
      const res = await fetch(urls.index, {
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
          ? `${cleanNames.join(', ')} source is added. Now ask your questions with AI!`
          : (data.message || 'Indexing failed.'),
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
    const nonValid = list.find((f) => {
      if (activeTab === 'portfolio') {
        return f.type !== 'application/pdf'
      } else {
        return f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.docx') && f.type !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }
    })
    
    if (nonValid) {
      setIndexResult({ success: false, message: activeTab === 'portfolio' ? 'Please select only PDF files.' : 'Please select only PDF or DOCX files.' })
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
      const res = await fetch(urls.collection, { method: 'DELETE' })
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
        <div className="tab-switcher" style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--border-color)', marginBottom: '1rem', paddingBottom: '0.5rem' }}>
          <button 
            type="button" 
            className={`btn ${activeTab === 'portfolio' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('portfolio')}
          >
            Portfolio RAG
          </button>
          <button 
            type="button" 
            className={`btn ${activeTab === 'transcript' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab('transcript')}
          >
            Transcript RAG
          </button>
        </div>
        <div className="header-top">
          <div className="brand">
            <h1>{activeTab === 'portfolio' ? 'Portfolio RAG' : 'Transcript RAG'}</h1>
            <p className="subtitle">
              {activeTab === 'portfolio' 
                ? 'AI-powered project recommender from your indexed portfolio data' 
                : 'AI-powered summary extraction from your meeting transcripts'}
            </p>
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
                accept={activeTab === 'portfolio' ? 'application/pdf' : 'application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document'}
                multiple
                onChange={handleIndex}
                disabled={busy}
                style={{ display: 'none' }}
              />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {indexing ? 'Indexing...' : (activeTab === 'portfolio' ? 'Upload PDF' : 'Upload Transcript (PDF/Word)')}
            </label>
            {activeTab === 'portfolio' && (
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
            )}
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
              <span className="collection-label">
                {collection.sources?.length > 0
                  ? <><strong>{collection.sources.map(s => s.replace(/^upload-\d+-[a-z0-9]+-/, '')).join(', ')}</strong> is indexed</>
                  : 'Data indexed'}
              </span>
              <span className="collection-detail">{collection.points} chunks ready for questions</span>
            </div>
          ) : (
            <span className="collection-label">No data indexed yet. Upload a PDF or click Index Default to get started.</span>
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
              <p>{activeTab === 'portfolio' ? 'Ask me anything about your portfolio projects' : 'Ask me anything to summarize your transcript'}</p>
              <div className="empty-examples">
                {activeTab === 'portfolio' ? (
                  <>
                    <span>"What projects are in the portfolio?"</span>
                    <span>"Summarize my experience"</span>
                  </>
                ) : (
                  <>
                    <span>"Extract key action items"</span>
                    <span>"Summarize the recent meeting"</span>
                  </>
                )}
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
                      
                      {activeTab === 'transcript' && msg.role === 'assistant' && !msg.error && i > 0 && (
                        <div className="message-feedback" style={{ marginTop: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          {!msg.feedbackSent ? (
                            <>
                              <button 
                                className="btn-icon" 
                                onClick={() => handleFeedback(i, true)}
                                title="Helpful"
                                style={{ padding: '4px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '4px' }}
                              >
                                👍
                              </button>
                              <button 
                                className="btn-icon" 
                                onClick={() => {
                                  const corr = prompt("How should this have been answered? ( AI will learn from this )")
                                  if (corr) handleFeedback(i, false, corr)
                                }}
                                title="Not helpful - provide correction"
                                style={{ padding: '4px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '4px' }}
                              >
                                👎
                              </button>
                            </>
                          ) : (
                            <span style={{ fontSize: '0.8rem', opacity: 0.7, color: 'var(--success-color)' }}>
                              {msg.feedbackPositive ? '✅ Feedback received' : '📝 Correction saved for learning'}
                            </span>
                          )}
                        </div>
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
              placeholder={indexing ? 'Indexing in progress, please wait...' : 'Describe a task or ask a question...'}
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
