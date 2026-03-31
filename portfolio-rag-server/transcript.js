import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { HfInference } from "@huggingface/inference";
import { QdrantVectorStore } from "@langchain/qdrant";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION_NAME = "transcript-docs";
const FEEDBACK_COLLECTION = "transcript-feedback";
const HF_EMBEDDING_MODEL = process.env.HF_EMBEDDING_MODEL || "sentence-transformers/all-MiniLM-L6-v2";
const HF_CHAT_MODEL_DEFAULT = "Qwen/Qwen2.5-7B-Instruct";

const router = express.Router();

const uploadDir = path.join(rootDir, "uploads-transcript");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) =>
      cb(
        null,
        `transcript-${Date.now()}-${file.originalname || "document.pdf"}`,
      ),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".docx") ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    cb(ok ? null : new Error("Only PDF and DOCX files are allowed"), ok);
  },
});
const MAX_PDFS = 25;

let embeddings;
let vectorStore;
let hf;

function getApiKey() {
  return process.env.TRANSCRIPT_HF_API_KEY || process.env.HUGGINGFACE_API_KEY;
}

async function initRag() {
  embeddings = new HuggingFaceInferenceEmbeddings({
    apiKey: getApiKey(),
    model: HF_EMBEDDING_MODEL,
  });
  vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
    url: QDRANT_URL,
    collectionName: COLLECTION_NAME,
    ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
  });
  hf = new HfInference(getApiKey());
}

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

const K_RETRIEVE = 5;

async function getRagAnswer(question) {
  const retriever = vectorStore.asRetriever({ k: K_RETRIEVE });

  const relevantChunks = await retriever.invoke(question);

  if (!relevantChunks || relevantChunks.length === 0) {
    return {
      answer: "No transcript data found. Please index a PDF first using 'Upload PDF'.",
      recommendation: null,
    };
  }

  const context = relevantChunks.map((doc) => doc.pageContent).join("\n\n");

  // --- SELF-LEARNING: FETCH PAST FEEDBACK ---
  let feedbackContext = "";
  try {
    const feedbackStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
      url: QDRANT_URL,
      collectionName: FEEDBACK_COLLECTION,
    });
    const pastCorrections = await feedbackStore.asRetriever({ k: 2 }).invoke(question);
    if (pastCorrections.length > 0) {
      feedbackContext = "\n\nPast User Corrections (Learn from these):\n" + 
        pastCorrections.map(f => `- User Question: ${f.metadata.question}\n  Corrected Answer: ${f.pageContent}`).join("\n");
    }
  } catch (e) {
    // If feedback collection doesn't exist yet, ignore
  }

  const systemPrompt = `
You are a highly capable AI Assistant specializing in summarizing meeting transcripts and extracting key action items.
${feedbackContext ? feedbackContext : ""}

-----------------------------------
## INPUT
-----------------------------------

USER QUESTION:
${question}

RETRIEVED TRANSCRIPT CONTEXT:
${context}

-----------------------------------
## OUTPUT FORMAT (DEFAULT)
-----------------------------------

Call summary
[Write a comprehensive, narrative, multi-paragraph summary. DO NOT use bullet points in this section.]

Consolidated Action Items
- [Detailed action item]
- [Detailed action item]

-----------------------------------
## CRITICAL RULES
-----------------------------------

1. You MUST provide an identical set and number of items regardless of the format. If there are 7 actionable points identified, you MUST output exactly 7 bullet points (default) OR exactly 7 tasks (if requested).
2. The DEFAULT format is: "Call summary" (multi-paragraph narrative) followed by "Consolidated Action Items" (a single unified bulleted list).
3. UNIFIED LIST RULE: You MUST combine ALL action items into ONE single list under the "Consolidated Action Items" heading. DO NOT group, categorize, or split action items by team, person, or department (e.g., do NOT create sections like "Action items for Team X").
4. CONVERT TO TASKS RULE: If the user specifically asks to "convert to tasks", "make tasks", or similar phrasing, you MUST:
   a. OMIT the "Call summary" entirely.
   b. Convert each individual bullet point from the "Consolidated Action Items" list into a formal Task structure.
   c. USE THIS EXACT STRUCTURE:
      Task [Number]
      Heading: [Clear, concise title derived from the bullet point]
      Description: [Detailed context and instructions derived directly from the bullet point]

5. STRICT 1-TO-1 ALIGNMENT: There must be a PERFECT 1-to-1 correspondence between the bulleted list and the task list. Each bullet point from the summary view MUST map to exactly one Task in the task view. The content of "Task 1" must match the first bullet point, "Task 2" the second, and so on.
6. Only generate items derived directly from the transcript. No assumptions, no extras, no prior knowledge.
7. In the Task structure, ensure there is NO colon after the Task Number (e.g., Task 1).
8. DO NOT include any person's name (like Deepak, Stefan, Atul, etc.) in any part of the summary or items. Exclude names entirely.
9. Use ONLY the transcript context provided. Do NOT hallucinate.
-----------------------------------
`;

  const chatModel = process.env.HF_CHAT_MODEL || HF_CHAT_MODEL_DEFAULT;
  const chatArgs = {
    model: chatModel,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: question,
      },
    ],
    max_tokens: 1500,
    temperature: 0
  };
  if (process.env.HF_CHAT_PROVIDER) {
    chatArgs.provider = process.env.HF_CHAT_PROVIDER;
  }
  const response = await hf.chatCompletion(chatArgs);
  const raw = getChatMessageContent(response.choices?.[0]?.message);

  return { answer: raw, recommendation: null };
}

function getErrorMessage(err) {
  if (!err) return "RAG request failed";
  const code = err.cause?.code ?? err.cause?.errors?.[0]?.code;
  if (code === "ECONNREFUSED" || (err.message && err.message.includes("fetch failed"))) {
    return "Qdrant is not running. Start it on port 6333 (e.g. docker-compose up -d qdrant), then run Index from the app.";
  }
  if (typeof err.message === "string" && err.message) return err.message;
  return String(err);
}

router.get("/collection", async (req, res) => {
  try {
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const client = new QdrantClient({
      url: QDRANT_URL,
      ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    });
    const exists = await client.collectionExists(COLLECTION_NAME);
    if (!exists.exists) {
      return res.json({ exists: false, points: 0, sources: [] });
    }
    const info = await client.getCollection(COLLECTION_NAME);
    const pointCount = info.points_count ?? 0;

    let sources = [];
    try {
      const scroll = await client.scroll(COLLECTION_NAME, { limit: 100, with_payload: true, with_vector: false });
      const sourceSet = new Set();
      for (const pt of scroll.points || []) {
        const src = pt.payload?.metadata?.source || pt.payload?.source;
        if (src) sourceSet.add(src);
      }
      sources = [...sourceSet];
    } catch (_) { }

    return res.json({ exists: true, points: pointCount, sources });
  } catch (err) {
    const code = err.cause?.code ?? err.cause?.errors?.[0]?.code;
    if (code === "ECONNREFUSED" || (err.message && err.message.includes("fetch failed"))) {
      return res.json({ exists: false, points: 0, sources: [], offline: true });
    }
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to get collection info" });
  }
});

router.delete("/collection", async (req, res) => {
  try {
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const client = new QdrantClient({
      url: QDRANT_URL,
      ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    });
    const exists = await client.collectionExists(COLLECTION_NAME);
    if (!exists.exists) {
      return res.json({ success: true, message: "No collection to delete." });
    }
    await client.deleteCollection(COLLECTION_NAME);
    vectorStore = null;
    return res.json({ success: true, message: "Collection deleted successfully." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message || "Failed to delete collection" });
  }
});

router.post("/index", (req, res, next) => {
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
  try {
    if (!uploadedPaths.length) {
      return res.status(400).json({
        success: false,
        message: "No transcript file uploaded.",
      });
    }

    if (!getApiKey()) {
      throw new Error("HUGGINGFACE_API_KEY is not set in .env");
    }

    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const qdrantClient = new QdrantClient({
      url: QDRANT_URL,
      ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    });

    // Check if collection exists
    try {
      const exists = await qdrantClient.collectionExists(COLLECTION_NAME);
      if (exists.exists) {
        // delete it to replace
        await qdrantClient.deleteCollection(COLLECTION_NAME);
      }
    } catch (e) { }

    const docs = [];
    const sources = [];
    for (const p of uploadedPaths) {
      const resolved = path.resolve(p);
      const isDocx = resolved.toLowerCase().endsWith(".docx");
      const loader = isDocx ? new DocxLoader(resolved) : new PDFLoader(resolved);
      const loadedDocs = await loader.load();
      const label = path.basename(resolved);
      sources.push(label);
      for (const d of loadedDocs) {
        d.metadata = { ...d.metadata, source: label };
      }
      docs.push(...loadedDocs);
    }

    if (!docs.length) throw new Error("No documents loaded from PDF(s)");

    const embeddingsInstance = new HuggingFaceInferenceEmbeddings({
      apiKey: getApiKey(),
      model: HF_EMBEDDING_MODEL,
    });

    const store = await QdrantVectorStore.fromExistingCollection(embeddingsInstance, {
      url: QDRANT_URL,
      collectionName: COLLECTION_NAME,
      ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    });

    await store.addDocuments(docs);
    vectorStore = null;

    return res.json({
      success: true,
      message: `Indexed ${uploadedPaths.length} transcript(s) (${docs.length} chunks).`,
      sources,
    });
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
      if (p && fs.existsSync(p)) fs.unlink(p, () => { });
    }
  }
});

router.post("/chat", async (req, res) => {
  try {
    if (!getApiKey()) {
      return res.status(500).json({
        error: "HUGGINGFACE_API_KEY is not set. Add it to portfolio Rag server/.env and restart the server.",
      });
    }
    const { question } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'question' in body" });
    }
    const trimmed = question.trim();
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

router.post("/feedback", async (req, res) => {
  try {
    const { question, answer, isPositive, correction } = req.body;
    
    if (!question || isPositive === undefined) {
      return res.status(400).json({ error: "Missing required feedback fields" });
    }

    // Only store corrections for learning
    if (!isPositive && correction) {
      const { QdrantClient } = await import("@qdrant/js-client-rest");
      const client = new QdrantClient({ url: QDRANT_URL });
      
      const exists = await client.collectionExists(FEEDBACK_COLLECTION);
      if (!exists.exists) {
        // Create collection if first feedback
        await client.createCollection(FEEDBACK_COLLECTION, {
          vectors: { size: 384, distance: "Cosine" } 
        });
      }

      const feedbackStore = await QdrantVectorStore.fromExistingCollection(new HuggingFaceInferenceEmbeddings({
        apiKey: getApiKey(),
        model: HF_EMBEDDING_MODEL,
      }), {
        url: QDRANT_URL,
        collectionName: FEEDBACK_COLLECTION,
      });

      await feedbackStore.addDocuments([{
        pageContent: correction,
        metadata: { question, originalAnswer: answer, timestamp: new Date().toISOString() }
      }]);
    }

    return res.json({ success: true, message: "Feedback saved. AI will learn from this." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save feedback" });
  }
});

export default router;
