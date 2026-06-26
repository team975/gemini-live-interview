import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { buildStoreFromKB, embedTexts } from './rag.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_ID  = process.env.VERTEX_PROJECT_ID;
const LOCATION    = process.env.VERTEX_LOCATION || 'europe-west1';
const MODEL       = process.env.VERTEX_MODEL || 'gemini-live-2.5-flash-native-audio';
// Modo testo NON usa Live (nessun Live text-capable è pubblicato in EU): chat standard.
const TEXT_MODEL  = process.env.TEXT_MODEL || 'gemini-2.5-flash';
const KICKOFF_TXT = 'Inizia ora la conversazione con il tuo messaggio di apertura.';
const AISTUDIO_KEY = process.env.GOOGLE_AI_STUDIO_KEY;

// Use AI Studio if key is set, otherwise Vertex AI
const useAIStudio = !!AISTUDIO_KEY;

if (!useAIStudio && !PROJECT_ID) {
  console.error('[proxy] Set GOOGLE_AI_STUDIO_KEY (AI Studio) or VERTEX_PROJECT_ID (Vertex AI) in .env');
  process.exit(1);
}

// Service account via env (deploy) — altrimenti ADC (gcloud login, locale).
let googleAuthOptions;
if (process.env.GOOGLE_SA_JSON) {
  try {
    const cred = JSON.parse(process.env.GOOGLE_SA_JSON);
    googleAuthOptions = { credentials: cred };
    const pk = cred.private_key || '';
    console.log('[proxy] auth: service account da GOOGLE_SA_JSON');
    console.log('[proxy][diag] SA email=%s | pk len=%d | pk has real newlines=%s | starts=%s | ends=%s',
      cred.client_email, pk.length, /\n/.test(pk),
      JSON.stringify(pk.slice(0, 28)), JSON.stringify(pk.slice(-28)));
  } catch (e) {
    console.error('[proxy] GOOGLE_SA_JSON non e\' JSON valido:', e.message);
    process.exit(1);
  }
} else {
  console.log('[proxy] auth: ADC (credenziali locali)');
}

const ai = useAIStudio
  ? new GoogleGenAI({ apiKey: AISTUDIO_KEY })
  : new GoogleGenAI({ vertexai: true, project: PROJECT_ID, location: LOCATION, googleAuthOptions });

// Tool RAG esposto al modello Live: lui decide quando interrogare la KB
// (modo Live-nativo: niente race di iniezione per-turno su uno stream continuo).
const KB_TOOL = {
  functionDeclarations: [{
    name: 'cerca_kb',
    description: "Cerca informazioni nella knowledge base dell'intervista. Usalo SEMPRE prima di porre domande o fare affermazioni specifiche sul dominio/azienda/persona, per ancorare la conversazione ai fatti reali forniti.",
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING', description: 'Argomento o domanda da cercare nella knowledge base' } },
      required: ['query'],
    },
  }],
};

const app = express();
app.use(express.json());

// CORS aperto per gli endpoint /api (chiamati dal browser dalle pagine Softr).
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Diagnostica: (1) mint token SA esplicito (isola rete OAuth), (2) generateContent.
app.get('/api/diag', async (req, res) => {
  const out = {};
  // (1) token mint diretto via google-auth-library
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const ga = new GoogleAuth({
      credentials: googleAuthOptions?.credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const t0 = Date.now();
    const client = await ga.getClient();
    const tok = await client.getAccessToken();
    out.tokenMint = { ok: true, len: (tok?.token || '').length, ms: Date.now() - t0 };
  } catch (e) {
    out.tokenMint = { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
  // (1b) fetch RAW a Vertex col token mintato (bypassa l'SDK)
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const ga = new GoogleAuth({ credentials: googleAuthOptions?.credentials, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const tok = (await (await ga.getClient()).getAccessToken()).token;
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${TEXT_MODEL}:generateContent`;
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }) });
    out.rawFetch = { status: r.status, body: (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160) };
  } catch (e) {
    out.rawFetch = { error: String(e?.message || e).slice(0, 200) };
  }
  // (2) generateContent via SDK
  try {
    const r = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    });
    out.generate = { ok: true, text: (r?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '').slice(0, 60) };
  } catch (e) {
    out.generate = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
  res.json(out);
});

app.get('/health', (req, res) => res.json({
  ok: true,
  mode: useAIStudio ? 'ai-studio' : 'vertex-ai',
  model: MODEL,
  location: LOCATION,
}));

// --- Lettura dati intervistato da Softr (via PONTE n8n) ---
// Il browser passa ?recordId=… (link generato da Softr). Qui (server-side, EU) chiamiamo
// il webhook n8n "gemini-proxy" che fa il getOne su Softr e ritorna i campi anagrafici.
// L'auth header del webhook resta lato server: non finisce mai nel browser.
const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL; // es. https://n8n.tacita.ai/webhook/gemini-proxy
const PROXY_AUTH_NAME  = process.env.GEMINI_PROXY_AUTH_HEADER_NAME;  // es. X-Tacita-Auth
const PROXY_AUTH_VALUE = process.env.GEMINI_PROXY_AUTH_HEADER_VALUE;

const pickStr = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

app.get('/api/interview', async (req, res) => {
  const recordId = String(req.query.recordId || req.query.id || '').trim();
  if (!recordId) return res.status(400).json({ ok: false, error: 'missing_recordId' });
  if (!GEMINI_PROXY_URL) return res.status(500).json({ ok: false, error: 'proxy_not_configured' });

  try {
    const url = new URL(GEMINI_PROXY_URL);
    url.searchParams.set('recordId', recordId);
    url.searchParams.set('id', recordId);
    const headers = { accept: 'application/json' };
    if (PROXY_AUTH_NAME && PROXY_AUTH_VALUE) headers[PROXY_AUTH_NAME] = PROXY_AUTH_VALUE;

    const r = await fetch(url, { headers });
    if (!r.ok) {
      const body = await r.text();
      console.error('[proxy] gemini-proxy http', r.status, body.slice(0, 200));
      return res.status(502).json({ ok: false, error: 'proxy_unavailable', status: r.status });
    }
    let data = await r.json();
    if (Array.isArray(data)) data = data[0] || {};
    if (data?.json) data = data.json;            // n8n a volte incapsula in .json
    const src = data?.fields ? { ...data, ...data.fields } : data;
    if (src?.ok === false) {
      return res.status(404).json({ ok: false, error: src.error || 'record_not_found' });
    }

    const profile = {
      ok: true,
      recordId,
      nome:    pickStr(src, 'nome', 'Nome', 'Custom1'),
      cognome: pickStr(src, 'cognome', 'Cognome', 'Custom2'),
      ruolo:   pickStr(src, 'ruolo', 'Ruolo', 'Custom3'),
      azienda: pickStr(src, 'azienda', 'Azienda', 'Custom4'),
    };
    res.json(profile);
  } catch (e) {
    console.error('[proxy] /api/interview err:', e.message);
    res.status(502).json({ ok: false, error: 'proxy_error', message: e.message });
  }
});

// --- Richiesta link intervista via email (magic-link) ---
// Form Softr -> qui. Validiamo il dominio email (solo @sharazad.com), poi inoltriamo
// al webhook n8n "gemini-auth-request" che invia la mail con il link ?recordId.
// Risposta sempre {ok:true} (non riveliamo se l'email è autorizzata o meno).
const AUTH_WEBHOOK = process.env.GEMINI_AUTH_WEBHOOK; // https://n8n.tacita.ai/webhook/gemini-auth-request
const AUTH_SECRET  = process.env.GEMINI_AUTH_SECRET;  // header condiviso con n8n
const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'sharazad.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

app.post('/api/auth-request', async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const nome = String(b.nome || '').trim();
  const cognome = String(b.cognome || '').trim();
  const recordId = String(b.recordId || '').trim();
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const domain = email.split('@')[1] || '';
  const domainOk = ALLOWED_EMAIL_DOMAINS.includes(domain);

  // Non riveliamo l'esito: rispondiamo sempre ok. Inoltriamo solo se valido + autorizzato.
  if (emailOk && domainOk && recordId && AUTH_WEBHOOK) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (AUTH_SECRET) headers['x-gemini-auth'] = AUTH_SECRET;
      const r = await fetch(AUTH_WEBHOOK, {
        method: 'POST', headers,
        body: JSON.stringify({ nome, cognome, email, recordId }),
      });
      console.log('[proxy] auth-request inoltrata', email, 'http', r.status);
    } catch (e) {
      console.error('[proxy] auth-request forward err:', e.message);
    }
  } else {
    console.log('[proxy] auth-request scartata (emailOk=%s domainOk=%s rec=%s)', emailOk, domainOk, !!recordId);
  }
  res.json({ ok: true });
});

// Serve la build di produzione (single-server: stesso host per UI + /ws).
const DIST = path.join(__dirname, '..', 'dist');
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
  console.log('[proxy] serve build statica da', DIST);
}

wss.on('connection', (client) => {
  console.log('[proxy] client connected, mode:', useAIStudio ? 'AI Studio' : 'Vertex AI');

  let session = null;          // sessione Live corrente
  let setupCfg = null;         // config inviata dal client (riusata sui resume)
  let store = null;            // vector store KB della sessione (null se niente KB)
  let mode = 'voice';          // 'voice' (Live native-audio) | 'text' (chat standard)
  let textSys = undefined;     // systemInstruction per il modo testo
  const chatHistory = [];      // storico chat (modo testo)
  let lastHandle = null;       // ultimo sessionResumption handle
  let setupSent = false;       // setup_complete inviato al client (1 sola volta)
  let clientClosed = false;    // il browser ha chiuso -> non riconnettere
  let reconnecting = false;
  const micQueue = [];         // audio mic arrivato durante il gap di reconnect

  // --- Cattura trascrizione lato server (robusta anche se il browser si chiude) ---
  const turns = [];
  let curUser = '', curModel = '';
  const startedAt = new Date().toISOString();
  const sessionId = 'iv_' + Math.random().toString(36).slice(2, 10);
  let saved = false;

  const flushTurn = () => {
    if (curUser.trim()) turns.push({ role: 'user', text: curUser.trim() });
    if (curModel.trim()) turns.push({ role: 'model', text: curModel.trim() });
    curUser = ''; curModel = '';
  };

  const saveTranscript = async () => {
    if (saved) return;
    saved = true;
    flushTurn();
    if (!turns.length) return;
    const payload = { sessionId, startedAt, endedAt: new Date().toISOString(), turnCount: turns.length, turns };
    const url = process.env.TRANSCRIPT_WEBHOOK;
    if (!url) { console.log('[proxy] transcript (no webhook):', JSON.stringify(payload).slice(0, 600)); return; }
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      console.log('[proxy] transcript inviata', sessionId, 'turni', turns.length, 'http', r.status);
    } catch (e) {
      console.error('[proxy] save transcript err:', e.message);
    }
  };

  // Apre/riapre la sessione Live. Con handle = ripresa trasparente (browser non se ne accorge).
  const openSession = async (resumeHandle) => {
    const cfg = { ...(setupCfg || {}) };
    if (resumeHandle) {
      cfg.sessionResumption = { handle: resumeHandle };
      console.log('[proxy] resume con handle');
    }
    try {
      session = await ai.live.connect({
        model: MODEL,
        config: cfg,
        callbacks: {
          onopen: () => {
            console.log('[proxy] session open ✓');
            reconnecting = false;
            // flush mic accumulato durante il gap
            for (const a of micQueue.splice(0)) {
              try { session.sendRealtimeInput({ audio: a }); } catch {}
            }
            if (!setupSent && client.readyState === WebSocket.OPEN) {
              setupSent = true;
              client.send(JSON.stringify({ setup_complete: {} }));
            }
          },
          onmessage: async (serverMsg) => {
            const sr = serverMsg.sessionResumptionUpdate || serverMsg.session_resumption_update;
            if (sr?.newHandle || sr?.new_handle) lastHandle = sr.newHandle || sr.new_handle;

            // TOOL CALL (RAG): il modello chiede alla knowledge base → ricerca vettoriale → risposta.
            const tc = serverMsg.toolCall || serverMsg.tool_call;
            if (tc?.functionCalls?.length) {
              for (const fc of tc.functionCalls) {
                let response;
                try {
                  if (fc.name === 'cerca_kb' && store) {
                    const q = (fc.args?.query || '').toString();
                    const [qv] = await embedTexts(ai, [q], 'RETRIEVAL_QUERY');
                    const hits = qv ? store.search(qv, 5) : [];
                    response = { risultati: hits.map(h => ({ testo: h.text, rilevanza: Number(h.score.toFixed(3)) })) };
                    console.log('[proxy] cerca_kb "%s" -> %d hit', q.slice(0, 60), hits.length);
                  } else {
                    response = { risultati: [], nota: 'nessuna knowledge base disponibile' };
                  }
                } catch (e) {
                  console.error('[proxy] cerca_kb err:', e.message);
                  response = { errore: e.message };
                }
                try { session?.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response }] }); }
                catch (e) { console.error('[proxy] sendToolResponse err:', e.message); }
              }
              return; // non inoltrare il toolCall al client
            }

            // cattura trascrizione
            const sc = serverMsg.serverContent;
            if (sc) {
              if (sc.inputTranscription?.text) curUser += sc.inputTranscription.text;
              if (sc.outputTranscription?.text) curModel += sc.outputTranscription.text;
              // modo testo: la risposta del modello arriva come text parts (no outputTranscription)
              if (sc.modelTurn?.parts) for (const p of sc.modelTurn.parts) if (p.text) curModel += p.text;
              if (sc.turnComplete) flushTurn();
            }
            // setupComplete dopo il primo (incluso sui resume): non rinviarlo al client
            const isSetup = serverMsg.setupComplete !== undefined || serverMsg.setup_complete !== undefined;
            if (isSetup) {
              if (setupSent) return;
              setupSent = true;
            }
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(serverMsg));
          },
          onerror: (err) => {
            console.error('[proxy] session error:', String(err).slice(0, 200));
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ _proxy_error: String(err) }));
            }
          },
          onclose: (ev) => {
            console.log('[proxy] session closed code=%s reason=%s', ev?.code, String(ev?.reason).slice(0, 120));
            session = null;
            if (clientClosed) return;
            // ripresa trasparente: riconnetti con l'ultimo handle
            if (lastHandle && !reconnecting) {
              reconnecting = true;
              console.log('[proxy] riconnessione sessione…');
              openSession(lastHandle).catch((e) => {
                console.error('[proxy] reconnect fallito:', e.message);
                if (client.readyState === WebSocket.OPEN) client.close();
              });
            } else if (!lastHandle) {
              if (client.readyState === WebSocket.OPEN) client.close();
            }
          },
        },
      });
    } catch (err) {
      console.error('[proxy] connect error:', err.message);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ _proxy_error: err.message }));
        client.close();
      }
    }
  };

  const forwardMsg = (msg) => {
    try {
      if (msg.realtime_input?.media_chunks) {
        for (const chunk of msg.realtime_input.media_chunks) {
          const audio = { data: chunk.data, mimeType: chunk.mime_type };
          if (session) session.sendRealtimeInput({ audio });
          else micQueue.push(audio);   // gap di reconnect: non perdere la voce
        }
        return;
      }
      if (msg.client_content) {
        const cc = msg.client_content;
        // cattura testo digitato (escludi il kickoff nascosto)
        const txt = (cc.turns || []).map(t => (t.parts || []).map(p => p.text).join(' ')).join(' ').trim();
        if (txt && txt !== 'Inizia ora la conversazione con il tuo messaggio di apertura.') {
          flushTurn();
          turns.push({ role: 'user', text: txt });
        }
        if (session) session.sendClientContent({ turns: cc.turns, turnComplete: cc.turn_complete ?? true });
        return;
      }
    } catch (e) {
      console.error('[proxy] forward error:', e.message);
    }
  };

  // --- Modo TESTO: chat standard (no Live) con tool-loop RAG. Streama testo al client
  // come serverContent.modelTurn.parts, identico al formato Live -> il client non distingue. ---
  const genTextTurn = async (userText) => {
    const isKickoff = userText === KICKOFF_TXT;
    chatHistory.push({ role: 'user', parts: [{ text: userText }] });
    if (!isKickoff) { flushTurn(); turns.push({ role: 'user', text: userText }); }
    const tools = store ? [KB_TOOL] : undefined;
    try {
      for (let hop = 0; hop < 5; hop++) {
        const stream = await ai.models.generateContentStream({
          model: TEXT_MODEL, contents: chatHistory, config: { systemInstruction: textSys, tools },
        });
        const modelParts = [];
        const calls = [];
        for await (const ch of stream) {
          const parts = ch.candidates?.[0]?.content?.parts || [];
          for (const p of parts) {
            if (p.text) {
              modelParts.push({ text: p.text });
              curModel += p.text;
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ text: p.text }] } } }));
              }
            }
            if (p.functionCall) { calls.push(p.functionCall); modelParts.push({ functionCall: p.functionCall }); }
          }
        }
        chatHistory.push({ role: 'model', parts: modelParts.length ? modelParts : [{ text: '' }] });
        if (!calls.length) break;
        // esegui le tool call e re-itera col risultato
        const frParts = [];
        for (const fc of calls) {
          let response;
          try {
            if (fc.name === 'cerca_kb' && store) {
              const q = (fc.args?.query || '').toString();
              const [qv] = await embedTexts(ai, [q], 'RETRIEVAL_QUERY');
              const hits = qv ? store.search(qv, 5) : [];
              response = { risultati: hits.map(h => ({ testo: h.text, rilevanza: Number(h.score.toFixed(3)) })) };
              console.log('[proxy] (text) cerca_kb "%s" -> %d hit', q.slice(0, 60), hits.length);
            } else { response = { risultati: [] }; }
          } catch (e) { response = { errore: e.message }; }
          frParts.push({ functionResponse: { name: fc.name, response } });
        }
        chatHistory.push({ role: 'user', parts: frParts });
      }
    } catch (e) {
      console.error('[proxy] genText err:', e.message);
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ _proxy_error: e.message }));
    }
    flushTurn();
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ serverContent: { turnComplete: true } }));
  };

  client.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.setup && !setupCfg) {
      setupCfg = msg.setup || {};
      mode = msg.mode === 'text' ? 'text' : 'voice';
      // KB opzionale: chunk + embed (Vertex EU) -> vector store + tool cerca_kb
      if (msg.kb && msg.kb.trim()) {
        try {
          console.log('[proxy] embedding KB…');
          store = await buildStoreFromKB(ai, msg.kb);
          if (store?.size) {
            setupCfg.tools = [...(setupCfg.tools || []), KB_TOOL];
            console.log('[proxy] KB pronta, chunk:', store.size);
          }
        } catch (e) {
          console.error('[proxy] KB embed err:', e.message);
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ _proxy_error: 'Preparazione knowledge base fallita: ' + e.message }));
          }
          return;
        }
      }
      if (mode === 'text') {
        textSys = setupCfg.systemInstruction || undefined;
        setupSent = true;
        console.log('[proxy] text-mode chat, model:', TEXT_MODEL, 'kbChunks:', store?.size || 0);
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ setup_complete: {} }));
      } else {
        console.log('[proxy] starting Live session, model:', MODEL, 'kbChunks:', store?.size || 0);
        await openSession(null);
      }
      return;
    }

    // Modo testo: i turni utente vanno alla chat standard, non a Live.
    if (mode === 'text') {
      if (msg.client_content) {
        const cc = msg.client_content;
        const txt = (cc.turns || []).map(t => (t.parts || []).map(p => p.text).join(' ')).join(' ').trim();
        if (txt) await genTextTurn(txt);
      }
      return;
    }

    forwardMsg(msg);
  });

  client.on('close', () => {
    console.log('[proxy] client disconnected');
    clientClosed = true;
    saveTranscript();
    try { session?.close(); } catch {}
  });

  client.on('error', (err) => {
    console.error('[proxy] client error:', err.message);
    clientClosed = true;
    saveTranscript();
    try { session?.close(); } catch {}
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[proxy] http://localhost:${PORT}`);
  console.log(`[proxy] mode=${useAIStudio ? 'AI Studio' : 'Vertex AI'} model=${MODEL}`);
});
