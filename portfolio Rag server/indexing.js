import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(rootDir, "..", "AI-Token", ".env") });
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION_NAME = "portfolio-docs";
const HF_EMBEDDING_MODEL =
  process.env.HF_EMBEDDING_MODEL || "sentence-transformers/all-MiniLM-L6-v2";

function getQdrantClient() {
  return new QdrantClient({
    url: QDRANT_URL,
    ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
  });
}

/** Uses the official client (same as LangChain) — raw fetch GET was unreliable for “exists” checks. */
async function qdrantCollectionExists() {
  const client = getQdrantClient();
  try {
    const r = await client.collectionExists(COLLECTION_NAME);
    return r.exists === true;
  } catch {
    return false;
  }
}

async function deleteExistingCollection() {
  const client = getQdrantClient();
  try {
    await client.deleteCollection(COLLECTION_NAME);
  } catch (e) {
    const status = e?.status ?? e?.response?.status;
    if (status === 404) return;
    const msg = String(e?.message ?? e ?? "").toLowerCase();
    if (msg.includes("404") || msg.includes("not found") || msg.includes("doesn't exist")) return;
    throw e;
  }
}

export function getPdfPath() {
  if (process.env.PDF_PATH) return process.env.PDF_PATH;
  const inRoot = path.join(rootDir, "protfolioData.pdf");
  const inDir = path.join(__dirname, "protfolioData.pdf");
  if (existsSync(inDir)) return inDir;
  return inRoot;
}

/** @param {string[]} paths */
async function loadPdfDocuments(paths) {
  const all = [];
  for (const pdfPath of paths) {
    const resolved = path.resolve(pdfPath);
    if (!existsSync(resolved)) {
      throw new Error(`PDF not found: ${resolved}`);
    }
    const loader = new PDFLoader(resolved);
    const docs = await loader.load();
    const label = path.basename(resolved);
    for (const d of docs) {
      d.metadata = { ...d.metadata, source: label };
    }
    all.push(...docs);
  }
  return all;
}

function qdrantStoreConfig() {
  return {
    url: QDRANT_URL,
    collectionName: COLLECTION_NAME,
    ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
  };
}

/**
 * Run indexing: load one or more PDFs, embed, upsert into Qdrant.
 * Appends chunks unless options.replace is true (Docker/CLI full re-index).
 *
 * Important: we always use fromExistingCollection + addDocuments so we never recreate the
 * collection except after an explicit delete (replace). fromDocuments() alone was easy to
 * mis-route and looked like “replace”; this path only adds new points.
 *
 * @param {string | string[] | undefined} pdfPathOverride
 * @param {{ replace?: boolean }} [options]
 */
export async function runIndexing(pdfPathOverride, options = {}) {
  const replace = options.replace === true;

  let paths;
  if (pdfPathOverride == null) {
    paths = [getPdfPath()];
  } else if (Array.isArray(pdfPathOverride)) {
    paths = pdfPathOverride.map((p) => path.resolve(p));
  } else {
    paths = [path.resolve(pdfPathOverride)];
  }

  if (!paths.length) {
    throw new Error("No PDF paths to index.");
  }
  for (const p of paths) {
    if (!existsSync(p)) {
      throw new Error(`PDF not found: ${p}. Set PDF_PATH or place protfolioData.pdf in the project folder.`);
    }
  }

  if (!process.env.HUGGINGFACE_API_KEY) {
    throw new Error("HUGGINGFACE_API_KEY is not set in .env");
  }

  const sources = paths.map((p) => path.basename(p));
  const docs = await loadPdfDocuments(paths);
  if (!docs.length) throw new Error("No documents loaded from PDF(s)");

  const embeddings = new HuggingFaceInferenceEmbeddings({
    apiKey: process.env.HUGGINGFACE_API_KEY,
    model: HF_EMBEDDING_MODEL,
  });

  const existedBefore = await qdrantCollectionExists();

  if (replace) {
    await deleteExistingCollection();
  }

  const store = await QdrantVectorStore.fromExistingCollection(embeddings, qdrantStoreConfig());
  await store.addDocuments(docs);

  let mode;
  if (replace) {
    mode = existedBefore ? "replaced" : "created";
  } else {
    mode = existedBefore ? "appended" : "created";
  }

  const pdfCount = paths.length;
  const message =
    mode === "appended"
      ? `Added ${pdfCount} PDF(s) to the index (${docs.length} chunks).`
      : mode === "replaced"
        ? `Re-indexed ${pdfCount} PDF(s) (${docs.length} chunks).`
        : `Indexed ${pdfCount} PDF(s) (${docs.length} chunks).`;

  return {
    success: true,
    message,
    chunks: docs.length,
    pdfCount,
    sources,
    mode,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runIndexing(undefined, { replace: true })
    .then((r) => {
      console.log(r.message, "Chunks:", r.chunks, "Files:", r.sources?.join(", "));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
