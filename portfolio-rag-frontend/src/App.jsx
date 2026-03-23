import { useState, useRef, useEffect } from 'react'
import './App.css'

/** Same-origin `/api` (Vite proxy or Docker). Set VITE_API_URL if the UI is on another origin (e.g. http://localhost:3001). */
const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
const API_URL = API_BASE ? `${API_BASE}/api/chat` : '/api/chat'
const INDEX_URL = API_BASE ? `${API_BASE}/api/index` : '/api/index'
const THEME_KEY = 'rag-theme'

export default function App() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [indexing, setIndexing] = useState(false)
  const [indexResult, setIndexResult] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light')
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
          ? "Server not reachable. In the rag-chat folder run: npm run server"
          : (text || `Request failed: ${res.status}`)
        throw new Error(res.ok ? 'Invalid response from server' : msg)
      }

      if (!res.ok) {
        const msg = data.error || (res.status >= 502 ? "Server not reachable. Run: npm run server" : `Request failed: ${res.status}`)
        throw new Error(msg)
      }
      const answerText = data.answer != null ? String(data.answer) : ""
      const recommendation = data.recommendation ?? null
      setMessages((m) => [...m, { role: 'assistant', content: answerText, recommendation }])
    } catch (err) {
      let msg = err?.message || 'Request failed'
      if (msg === 'Failed to fetch' || msg.includes('NetworkError')) {
        msg = 'Cannot reach server. In the rag-chat folder run: npm run server'
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
        setIndexResult({
          success: false,
          message: text?.slice(0, 200) || `Request failed: ${res.status}`,
        })
        return
      }
      if (!res.ok) {
        setIndexResult({
          success: false,
          message: data.message || data.error || `Request failed: ${res.status}`,
        })
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
    } catch (err) {
      let msg = err?.message || 'Indexing failed'
      if (msg === 'Failed to fetch' || msg.includes('NetworkError')) {
        msg = 'Cannot reach API. Start the RAG server on port 3001 (e.g. npm start in portfolio Rag server).'
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
    for (const f of list) {
      formData.append('pdf', f)
    }
    await doIndex(formData)
    e.target.value = ''
  }

  async function handleIndexDefault() {
    await doIndex()
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          <div>
            <h1>Project Recommender RAG</h1>
            <p>Describe a task and I will recommend the single best matching Project / Sprint / Cycle from your indexed data.</p>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="btn-theme"
              onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
              title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              aria-label="Toggle theme"
            >
              {theme === 'light' ? '☀️' : '🌙'}
            </button>
            <label className="btn-index" title="Upload one or more PDFs; new files are added to the same Qdrant index">
            <input
              type="file"
              accept="application/pdf"
              multiple
              onChange={handleIndex}
              disabled={loading || indexing}
              style={{ display: 'none' }}
            />
            {indexing ? 'Indexing…' : 'Upload PDF(s)'}
          </label>
            <button
              type="button"
              className="btn-index btn-index-default"
              onClick={handleIndexDefault}
              disabled={loading || indexing}
              title="Index default protfolioData.pdf from server folder"
            >
              Index default
            </button>
          </div>
        </div>
        <div className="header-info">
          {indexResult && (
            <p className={`index-result ${indexResult.success ? 'index-ok' : 'index-err'}`}>
              {indexResult.message}
              {indexResult.chunks != null && ` (${indexResult.chunks} chunks)`}
              {indexResult.success && indexResult.sources?.length > 0 && (
                <span className="index-sources"> — {indexResult.sources.join(', ')}</span>
              )}
            </p>
          )}
          <details className="guidance">
            <summary>How this assistant decides (click to expand)</summary>
            <div className="guidance-body">
              <p><strong>Core objective:</strong> Map your task description to the <strong>single most relevant</strong> item (Project / Sprint / Cycle) from the retrieved context.</p>
              <p><strong>Context rules:</strong> Uses only the retrieved items (k=5 for balanced recall). If nothing fits, it will say: "No relevant project found based on the given task."</p>
              <p><strong>Structure (P / X / C):</strong> Project (broad), Sprint (more specific), Cycle (most specific). When relevance is similar, it prefers <strong>Cycle &gt; Sprint &gt; Project</strong>.</p>
              <p><strong>Signals used:</strong> Title, Status, Priority, Team, Due Date and P/X/C level to decide which item best matches your task.</p>
              <p><strong>Output format:</strong> Returns JSON with <code>best_match</code> (id, title, reason) and <code>alternatives</code>.</p>
              <p><strong>Restrictions:</strong> It will not invent new items, change IDs/titles, or use knowledge outside the retrieved context.</p>
            </div>
          </details>
        </div>
      </header>

      <main className="main">
        <div className="messages">
          {messages.length === 0 && !loading && (
            <div className="empty">
              <p>Describe a task to get a PXC recommendation. For example:</p>
              <ul>
                <li>"What projects or skills are in the portfolio?"</li>
                <li>"Summarize my experience or contact details."</li>
              </ul>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`message message--${msg.role}`}>
              <span className="message-label">{msg.role === 'user' ? 'You' : 'AI'}</span>
              <div className="message-content">
                {msg.error ? (
                  <p className="message-error">{msg.error}</p>
                ) : (
                  <>
                    {msg.recommendation?.best_match && (
                      <div className="recommendation-card">
                        <h4 className="rec-label">Best match</h4>
                        <div className="rec-item rec-best">
                          <span className="rec-id">{msg.recommendation.best_match.id ?? '—'}</span>
                          <span className="rec-title">{msg.recommendation.best_match.title ?? '—'}</span>
                          <p className="rec-reason">{msg.recommendation.best_match.reason}</p>
                        </div>
                        {msg.recommendation.alternatives?.length > 0 && (
                          <div className="rec-alternatives">
                            <span className="rec-alt-label">Alternatives:</span>
                            <ul>
                              {msg.recommendation.alternatives.map((id, j) => (
                                <li key={j}>{id}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="message-text">{msg.content}</div>
                  </>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="message message--assistant">
              <span className="message-label">AI</span>
              <div className="message-content typing">
                <span></span><span></span><span></span>
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
              placeholder="e.g. Create notification system for task updates"
              disabled={loading}
              autoFocus
            />
            <button type="submit" disabled={loading || !input.trim()}>
              Send
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
