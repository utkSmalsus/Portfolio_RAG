import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { HfInference } from "@huggingface/inference";
import { QdrantVectorStore } from "@langchain/qdrant";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(rootDir, "..", "AI-Token", ".env") });
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION_NAME = "portfolio-docs";

/** Same default as indexing.js — keep in sync for collection compatibility */
const HF_EMBEDDING_MODEL =
  process.env.HF_EMBEDDING_MODEL || "sentence-transformers/all-MiniLM-L6-v2";
/** Mistral 7B often fails on free Inference routing; override via HF_CHAT_MODEL in .env */
const HF_CHAT_MODEL_DEFAULT = "Qwen/Qwen2.5-7B-Instruct";

const app = express();
app.use(cors());
app.use(express.json());

// Temp dir for uploaded PDFs
const uploadDir = path.join(rootDir, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) =>
      cb(
        null,
        `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${file.originalname || "document.pdf"}`,
      ),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = file.mimetype === "application/pdf";
    cb(ok ? null : new Error("Only PDF files are allowed"), ok);
  },
});
const MAX_PDFS = 25;

// Serve React build in production (portfolio-rag-frontend/dist)
if (process.env.NODE_ENV === "production") {
  const frontendDist = path.join(rootDir, "portfolio-rag-frontend", "dist");
  app.use(express.static(frontendDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

let embeddings;
let vectorStore;
let hf;

async function initRag() {
  embeddings = new HuggingFaceInferenceEmbeddings({
    apiKey: process.env.HUGGINGFACE_API_KEY,
    model: HF_EMBEDDING_MODEL,
  });
  vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
    url: QDRANT_URL,
    collectionName: COLLECTION_NAME,
    ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
  });
  hf = new HfInference(process.env.HUGGINGFACE_API_KEY);
}

/** Normalize HF chat message content (string or content-part array). */
function getChatMessageContent(message) {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && part.text != null) return String(part.text);
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

const K_RETRIEVE = 5; // balanced recall (3=precise, 5=balanced, 8=more recall)
const K_RETRIEVE_SUMMARY = 15; // for meta/summary queries

const META_QUERY_PATTERN = /^(total|how many|count|list|number of|summarize|overview|what projects)\s|^(total|how many|count|list|number of)\s|projects\?$/i;

function isMetaQuery(q) {
  const t = q.trim().toLowerCase();
  return META_QUERY_PATTERN.test(t) || /^(total|how many|count|list|number of|summarize|overview)\b/i.test(t) || /\b(total|all)\s+projects?\b/i.test(t);
}

const PORTFOLIO_KEYWORDS = /\b(project|sprint|cycle|task|P\d+|X\d+|C\d+|dashboard|notification|employee|HR|attendance|backup|search|portfolio|index|pdf|recommend|match|tag|assign)\b/i;

function isPortfolioQuery(q) {
  const t = q.trim();
  if (isMetaQuery(t)) return true;
  return PORTFOLIO_KEYWORDS.test(t);
}

async function getConversationalResponse(question) {
  const chatHf = new HfInference(process.env.HUGGINGFACE_API_KEY);
  const chatModel = process.env.HF_CHAT_MODEL || HF_CHAT_MODEL_DEFAULT;
  const chatArgs = {
    model: chatModel,
    messages: [
      {
        role: "system",
        content: `You are a friendly and helpful portfolio assistant. Your main job is to help users find the best matching Project/Sprint/Cycle from their indexed portfolio data.

For casual conversation (greetings, how are you, thanks, etc.) respond naturally and warmly, then gently remind the user that you can help them find projects from their portfolio data.

For general knowledge questions, answer briefly using your own knowledge, but mention that your specialty is portfolio project matching.

Keep responses concise (2-3 sentences max).`
      },
      { role: "user", content: question }
    ],
    max_tokens: 200,
  };
  if (process.env.HF_CHAT_PROVIDER) {
    chatArgs.provider = process.env.HF_CHAT_PROVIDER;
  }
  const response = await chatHf.chatCompletion(chatArgs);
  return getChatMessageContent(response.choices?.[0]?.message);
}

async function getRagAnswer(question) {
  const k = isMetaQuery(question) ? K_RETRIEVE_SUMMARY : K_RETRIEVE;
  const retriever = vectorStore.asRetriever({ k });
  const searchQuery = isMetaQuery(question) ? "project portfolio" : question;
  const relevantChunks = await retriever.invoke(searchQuery);
  if (!relevantChunks || relevantChunks.length === 0) {
    return {
      answer: "No data found. Please index a PDF first using 'Upload PDF' or 'Index default'.",
      recommendation: { best_match: { id: null, title: null, reason: "No matches in retrieved context." }, alternatives: [] },
    };
  }

  const context = relevantChunks.map((doc) => doc.pageContent).join("\n\n");

  if (isMetaQuery(question)) {
    const projectIds = [...new Set(context.match(/\bP\d+(?:-X\d+(?:-C\d+)?)?\b/g) || [])];
    const projectCount = projectIds.length;
    const answerText = projectCount > 0
      ? `Based on the indexed data: ${projectCount} project(s) found in the retrieved context.\n\n${projectCount <= 20 ? `IDs: ${projectIds.sort().join(", ")}` : `Sample IDs: ${projectIds.slice(0, 15).sort().join(", ")}...`}`
      : "No project IDs found in the indexed data.";
    return {
      answer: answerText,
      recommendation: { best_match: { id: null, title: null, reason: "Summary query." }, alternatives: projectIds.slice(0, 10) },
    };
  }

  const systemPrompt = `
You are a high-precision PXC (Project / Sprint / Cycle) Tagging Engine.

Your job:
👉 Given a user task description, assign the MOST RELEVANT project ID(s) from the retrieved context.

You are NOT a chatbot.
You are a STRICT decision + ranking system.

-----------------------------------
## INPUT
-----------------------------------

USER TASK:
"${question}"

RETRIEVED CONTEXT (k ≤ ${K_RETRIEVE}, usually ≤ 2):
${context}

-----------------------------------
## CORE GOAL
-----------------------------------

Return:
👉 Best matching ID (MANDATORY)
👉 Optional 1–2 alternative IDs (ONLY if strongly relevant)

Focus:
✔ Correct tagging  
✔ Semantic accuracy  
✔ No hallucination  

-----------------------------------
## HARD RULES (CRITICAL)
-----------------------------------

- ONLY use IDs and Titles from the given context
- DO NOT invent anything
- DO NOT use external knowledge
- If no strong match → return:

{
  "best_match": {
    "id": null,
    "title": "No relevant project",
    "reason": "No match found"
  },
  "alternatives": []
}

-----------------------------------
## UNDERSTANDING DATA
-----------------------------------

Each item:
- ID → unique identifier (MOST IMPORTANT)
- Title → main semantic signal

Hierarchy:
- Project → P###
- Sprint → P###-X#
- Cycle → P###-X#-C#

👉 Specificity priority:
Cycle > Sprint > Project (ONLY if relevance is similar)

-----------------------------------
## MATCHING ENGINE (STRICT PIPELINE)
-----------------------------------

### Step 1: Intent Extraction
Extract:
- Action → build / improve / fix / integrate / manage / create
- Target → dashboard / HR / notification / UI / API / search / etc.
- Goal → what user wants to achieve

---

### Step 2: Keyword Mapping
Match important words with Titles:
- "attendance" → attendance
- "notification / alert / message" → notification / messages
- "employee / HR" → HR systems
- "search" → search / smart search
- "dashboard / analytics" → dashboard

---

### Step 3: Semantic Matching (MOST IMPORTANT)
Match meaning, not just words:
- "track progress" ≈ dashboard
- "user communication" ≈ messages
- "data backup" ≈ backup system

---

### Step 4: Scoring (INTERNAL)
Score each item:

+5 → Strong semantic match  
+3 → Keyword overlap  
+2 → Functional alignment  
+1 → Specificity bonus (C > X > P)

👉 Select highest score ONLY

---

### Step 5: Noise Filtering
Ignore:
- Generic titles (e.g. "Development", "Improvement")
- Weak keyword matches
- Irrelevant items even if similar words exist

---

### Step 6: Tie Breaker
If similar:
1. More specific (C > X > P)
2. More descriptive title
3. More direct keyword match

---

{
  "best_match": {
    "id": "<EXACT ID from context>",
    "title": "<EXACT Title from context>",
    "reason": "<short, clear justification>"
  },
  "alternatives": ["<ID1>", "<ID2>"]
}

-----------------------------------
## OUTPUT RULES
-----------------------------------

- JSON ONLY (no text, no markdown)
- Use exact ID and Title from context
- Keep reason SHORT (1 line)
- Alternatives optional (max 2)

-----------------------------------
## EXAMPLES (REALISTIC)
-----------------------------------

User:
"Need to build dashboard to track task progress"

Output:
{
  "best_match": {
    "id": "P174",
    "title": "Dashboard",
    "reason": "Matches dashboard and task tracking"
  },
  "alternatives": []
}

---

User:
"Employee attendance tracking system"

Output:
{
  "best_match": {
    "id": "P261-X1-C2",
    "title": "Employee Page - Attendance",
    "reason": "Direct match for attendance functionality"
  },
  "alternatives": ["P261-X1"]
}

---

User:
"Setup messaging feature between users"

Output:
{
  "best_match": {
    "id": "P254-X11",
    "title": "Messages",
    "reason": "Matches messaging feature requirement"
  },
  "alternatives": []
}

---

User:
"Need automatic data backup system"

Output:
{
  "best_match": {
    "id": "P260",
    "title": "Automate Backup Process in ILF",
    "reason": "Direct match for backup automation"
  },
  "alternatives": []
}

---

User:
"Improve task popup UI"

Output:
{
  "best_match": {
    "id": "P058-X8",
    "title": "Improvement - Task Popup",
    "reason": "Matches UI improvement for task popup"
  },
  "alternatives": []
}

-----------------------------------

## FINAL BEHAVIOR

Always:
✔ Pick BEST match (not multiple weak ones)  
✔ Prefer accuracy over coverage  
✔ Prefer meaning over keywords  
✔ Prefer specific over generic  

You are a tagging engine, not a generator.
`;



const chatModel = process.env.HF_CHAT_MODEL || HF_CHAT_MODEL_DEFAULT;
  const chatArgs = {
    model: chatModel,
    messages: [{ role: "user", content: systemPrompt }],
    max_tokens: 300,
  };
  if (process.env.HF_CHAT_PROVIDER) {
    chatArgs.provider = process.env.HF_CHAT_PROVIDER;
  }
  const response = await hf.chatCompletion(chatArgs);

  const raw = getChatMessageContent(response.choices?.[0]?.message);

  // Try to parse JSON from LLM output (may be wrapped in ```json ... ```).
  let recommendation = null;
  let jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed && typeof parsed.best_match === "object" && Array.isArray(parsed.alternatives)) {
        recommendation = {
          best_match: {
            id: parsed.best_match?.id ?? null,
            title: parsed.best_match?.title ?? null,
            reason: parsed.best_match?.reason ?? "",
          },
          alternatives: parsed.alternatives.filter((a) => a && typeof a === "string"),
        };
      }
    } catch (_) {}
  }

  // Fallback: regex for legacy "Recommended Item" format.
  if (!recommendation) {
    const re =
      /Recommended Item(?:\s*\d*)?:\s*ID:\s*(?<id>P\d+(?:-X\d+(?:-C\d+)?)?|N\/A)\s*Title:\s*(?<title>.+?)\s*(?:\r?\n|\r)\s*Reason:\s*(?<reason>[\s\S]*?)(?=\n\n|Recommended Item|$)/i;
    const m = raw.match(re);
    if (m?.groups) {
      const { id, title, reason } = m.groups;
      recommendation = {
        best_match: { id: id === "N/A" ? null : id, title: title?.trim() ?? null, reason: reason?.trim() ?? "" },
        alternatives: [],
      };
    }
  }

  // Fallback: extract project tag from noisy output.
  if (!recommendation) {
    const projectMatch =
      raw.match(/(?:^|\n)\s*Project(?:\s*Name)?\s*:\s*([^\n;]+)/i) ||
      raw.match(/(?:^|\n)\s*Component\s*:\s*([^\n;]+)/i);
    const title = projectMatch?.[1]?.trim() || "No relevant project found based on the given task";
    const short = raw.split(/(?<=[.!?])\s+/).slice(0, 1).join(" ").trim();
    recommendation = {
      best_match: {
        id: null,
        title,
        reason: title.includes("No relevant") ? title : (short || "Best available project tag based on retrieved context."),
      },
      alternatives: [],
    };
  }

  // Build answer text for display.
  const best = recommendation.best_match;
  const answerText =
    best?.id && best?.title
      ? `Best match: ${best.id} – ${best.title}\n${best.reason ? `Reason: ${best.reason}` : ""}${recommendation.alternatives?.length ? `\n\nAlternatives: ${recommendation.alternatives.join(", ")}` : ""}`
      : best?.reason || "No relevant project found based on the given task.";

  return { answer: answerText, recommendation };
}

/** Hugging Face @huggingface/inference often throws a generic message; pull status + body when present. */
function formatProviderApiError(err) {
  const base = typeof err?.message === "string" ? err.message : String(err);
  const http = err?.httpResponse;
  if (!http) return base;
  const { status, body } = http;
  let detail = "";
  if (body && typeof body === "object") {
    if (typeof body.error === "string") detail = body.error;
    else if (body.error && typeof body.error === "object" && typeof body.error.message === "string")
      detail = body.error.message;
    else if (typeof body.message === "string") detail = body.message;
    else if (typeof body.detail === "string") detail = body.detail;
    else detail = JSON.stringify(body).slice(0, 1200);
  } else if (typeof body === "string" && body.trim()) {
    detail = body.trim().slice(0, 800);
  }
  const hint =
    status === 401 || status === 403
      ? " Check HUGGINGFACE_API_KEY (token needs access to Inference / the chosen model)."
      : status === 402
        ? " This model may require Hugging Face credits or a paid plan."
        : status === 429
          ? " Rate limited — wait and retry."
          : "";
  return [base, status && `HTTP ${status}`, detail].filter(Boolean).join(" — ") + hint;
}

function getErrorMessage(err) {
  if (!err) return "RAG request failed";
  const code = err.cause?.code ?? err.cause?.errors?.[0]?.code;
  if (code === "ECONNREFUSED" || (err.message && err.message.includes("fetch failed"))) {
    return "Qdrant is not running. Start it on port 6333 (e.g. docker-compose up -d qdrant), then run Index from the app.";
  }
  if (err.httpResponse) return formatProviderApiError(err);
  if (typeof err.message === "string" && err.message) return err.message;
  if (typeof err.error === "string") return err.error;
  return String(err);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/index", (req, res, next) => {
  upload.array("pdf", MAX_PDFS)(req, res, (err) => {
    if (err) {
      const msg =
        err.code === "LIMIT_FILE_SIZE"
          ? "A file is too large (max 50MB each)"
          : err.message || "Upload failed";
      return res.status(400).json({ success: false, message: msg });
    }
    next();
  });
}, async (req, res) => {
  const uploadedPaths = (req.files || []).map((f) => f.path).filter(Boolean);
  let paths = uploadedPaths;
  if (!paths.length) {
    const { getPdfPath } = await import("./indexing.js");
    const defaultPath = getPdfPath();
    if (fs.existsSync(defaultPath)) paths = [defaultPath];
  }
  try {
    if (!paths.length) {
      return res.status(400).json({
        success: false,
        message:
          "No PDF file uploaded. Select one or more PDFs, or place protfolioData.pdf in the project folder and use Index default.",
      });
    }
    const { runIndexing } = await import("./indexing.js");
    const result = await runIndexing(paths, { replace: true });
    vectorStore = null;
    return res.json(result);
  } catch (err) {
    console.error(err);
    const code = err.cause?.code ?? err.cause?.errors?.[0]?.code;
    const message =
      code === "ECONNREFUSED" || (err.message && err.message.includes("fetch failed"))
        ? "Qdrant is not running. Start it on port 6333 (e.g. docker-compose up -d qdrant)."
        : getErrorMessage(err) || err.message || "Indexing failed.";
    res.status(500).json({ success: false, message });
  } finally {
    for (const p of uploadedPaths) {
      if (p && fs.existsSync(p)) fs.unlink(p, () => {});
    }
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!process.env.HUGGINGFACE_API_KEY) {
      return res.status(500).json({
        error: "HUGGINGFACE_API_KEY is not set. Add it to portfolio Rag server/.env and restart the server.",
      });
    }
    const { question } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'question' in body" });
    }
    const trimmed = question.trim();
    if (!isPortfolioQuery(trimmed)) {
      const answer = await getConversationalResponse(trimmed);
      return res.json({ answer, recommendation: null });
    }
    await initRag();
    const result = await getRagAnswer(trimmed);
    const text = typeof result === "string" ? result : (result?.answer ?? result?.content ?? "");
    const recommendation = result?.recommendation ?? null;
    return res.json({ answer: text || "", recommendation });
  } catch (err) {
    console.error(err);
    const message = getErrorMessage(err);
    res.status(500).setHeader("Content-Type", "application/json");
    return res.send(JSON.stringify({ error: message }));
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`RAG API at http://localhost:${PORT}`);
  console.log("Qdrant will be connected on first chat request (must be running on port 6333).");
  console.log(`Embedding model: ${HF_EMBEDDING_MODEL}`);
  console.log(`Chat model: ${process.env.HF_CHAT_MODEL || HF_CHAT_MODEL_DEFAULT}`);
});
