// RAG per la knowledge base dell'intervista.
// Tutto EU: embeddings via Vertex AI (stesso client/region del proxy, europe-west1).
// Vector store dietro interfaccia pluggable: in-memory ora, Qdrant-EU drop-in per prod.

const EMBED_MODEL = process.env.EMBED_MODEL || 'text-multilingual-embedding-002';
const EMBED_BATCH = 50;          // instances per richiesta embedContent
const CHUNK_CHARS = 1200;        // ~300 token
const CHUNK_OVERLAP = 200;

// --- Chunking: spezza su paragrafi, accorpa fino a CHUNK_CHARS, con overlap. ---
export function chunkText(text, { maxChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const clean = (text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); };
  for (const p of paras) {
    if ((cur + '\n\n' + p).length <= maxChars) {
      cur = cur ? cur + '\n\n' + p : p;
      continue;
    }
    push();
    if (p.length <= maxChars) {
      cur = p;
    } else {
      // paragrafo lungo: spezza a finestra con overlap
      for (let i = 0; i < p.length; i += (maxChars - overlap)) {
        chunks.push(p.slice(i, i + maxChars).trim());
      }
      cur = '';
    }
  }
  push();
  return chunks;
}

// --- Embeddings via Vertex (ai = GoogleGenAI client del proxy). ---
export async function embedTexts(ai, texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const resp = await ai.models.embedContent({
      model: EMBED_MODEL,
      contents: batch,
      config: { taskType },
    });
    const embs = resp.embeddings || [];
    for (const e of embs) out.push(e.values);
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

// --- Interfaccia vector store. Sostituire con QdrantVectorStore (region EU) per prod. ---
export class InMemoryVectorStore {
  constructor() { this.items = []; } // { text, vector }
  add(items) { for (const it of items) this.items.push(it); }
  get size() { return this.items.length; }
  search(queryVector, k = 5) {
    return this.items
      .map(it => ({ text: it.text, score: cosine(queryVector, it.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

// --- Costruisce uno store dalla KB grezza: chunk -> embed -> store. ---
export async function buildStoreFromKB(ai, kbText) {
  const chunks = chunkText(kbText);
  if (!chunks.length) return null;
  const vectors = await embedTexts(ai, chunks, 'RETRIEVAL_DOCUMENT');
  const store = new InMemoryVectorStore();
  store.add(chunks.map((text, i) => ({ text, vector: vectors[i] })).filter(x => x.vector));
  return store;
}
