import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_ID  = process.env.VERTEX_PROJECT_ID;
const LOCATION    = process.env.VERTEX_LOCATION || 'europe-west1';
const MODEL       = process.env.VERTEX_MODEL || 'gemini-live-2.5-flash-native-audio';
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
    googleAuthOptions = { credentials: JSON.parse(process.env.GOOGLE_SA_JSON) };
    console.log('[proxy] auth: service account da GOOGLE_SA_JSON');
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

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.get('/health', (req, res) => res.json({
  ok: true,
  mode: useAIStudio ? 'ai-studio' : 'vertex-ai',
  model: MODEL,
  location: LOCATION,
}));

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
  let lastHandle = null;       // ultimo sessionResumption handle
  let setupSent = false;       // setup_complete inviato al client (1 sola volta)
  let clientClosed = false;    // il browser ha chiuso -> non riconnettere
  let reconnecting = false;
  const micQueue = [];         // audio mic arrivato durante il gap di reconnect

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
          onmessage: (serverMsg) => {
            const sr = serverMsg.sessionResumptionUpdate || serverMsg.session_resumption_update;
            if (sr?.newHandle || sr?.new_handle) lastHandle = sr.newHandle || sr.new_handle;
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
        if (session) session.sendClientContent({ turns: cc.turns, turnComplete: cc.turn_complete ?? true });
        return;
      }
    } catch (e) {
      console.error('[proxy] forward error:', e.message);
    }
  };

  client.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.setup && !session && !setupCfg) {
      setupCfg = msg.setup || {};
      console.log('[proxy] starting Live session, model:', MODEL);
      await openSession(null);
      return;
    }
    forwardMsg(msg);
  });

  client.on('close', () => {
    console.log('[proxy] client disconnected');
    clientClosed = true;
    try { session?.close(); } catch {}
  });

  client.on('error', (err) => {
    console.error('[proxy] client error:', err.message);
    clientClosed = true;
    try { session?.close(); } catch {}
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[proxy] http://localhost:${PORT}`);
  console.log(`[proxy] mode=${useAIStudio ? 'AI Studio' : 'Vertex AI'} model=${MODEL}`);
});
