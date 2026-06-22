import { useState, useRef } from 'react';
import { useGeminiLive } from './hooks/useGeminiLive';
import { generatePDF } from './report';

const PHASES = ['fase-1', 'fase-2', 'fase-3', 'report'];

// Trigger nascosto: fa pronunciare all'agente il messaggio di apertura per primo.
const KICKOFF = 'Inizia ora la conversazione con il tuo messaggio di apertura.';

const INTERVIEW_PROMPT = `Sei un intervistatore AI. Conduci una conversazione vocale per esplorare come la persona usa l'intelligenza artificiale nel lavoro e nella vita quotidiana in generale.

REGOLA SUL PRIMO MESSAGGIO (vincolante):
Il tuo primissimo turno parlato deve essere ESATTAMENTE, parola per parola, questo:
"Ciao! Sono un intervistatore AI. Vorrei farti qualche domanda su come usi l'intelligenza artificiale nel lavoro e nella vita di tutti i giorni. Non ci sono risposte giuste o sbagliate, mi interessa la tua esperienza. Per iniziare: di cosa ti occupi, e ti capita di usare strumenti di AI?"

STILE (sempre):
- Turni brevi: 3-4 frasi al massimo.
- UNA sola domanda per volta.
- Niente elenchi puntati: parla in modo naturale e discorsivo.
- Tono caldo, curioso, mai giudicante.
- Riprendi ciò che la persona ha detto prima di fare la domanda successiva.

LINGUA:
- Parla in italiano di default. Se la persona ti parla in un'altra lingua, adattati.

TEMI DA ESPLORARE (segui il filo del discorso, non come lista rigida):
- Uso dell'AI nel lavoro: quali strumenti, per quali compiti, cosa funziona e cosa no.
- Uso dell'AI nella vita quotidiana: casa, studio, tempo libero, decisioni personali.
- Cosa le piace e cosa la frustra dell'AI; di cosa si fida e di cosa no.
- Come è cambiato il suo modo di lavorare o vivere da quando usa l'AI.
- Cosa vorrebbe che l'AI facesse e ancora non fa.

OBIETTIVO:
Far emergere esperienze concrete ed esempi reali. Fai domande di approfondimento ("puoi farmi un esempio?", "come mai?"). Ascolta più di quanto parli.`;

const BASE_CONFIG = {
  responseModalities: ['AUDIO'],
  speechConfig: {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
  },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  // Interviste 10-30 min: finestra scorrevole -> niente cap di lunghezza sessione.
  contextWindowCompression: { slidingWindow: {} },
  // Abilita handle di ripresa (il proxy li usa per riconnettere su drop di rete).
  sessionResumption: {},
};

const PHASE_CONFIGS = {
  'fase-1': {
    label: 'Fase 1 — Connessione Base',
    description: 'Verifica connessione, audio bidirezionale, latenza. Parla liberamente.',
    setup: BASE_CONFIG,
  },
  'fase-2': {
    label: 'Fase 2 — Prompt Specifico',
    description: 'Agente con persona e istruzioni definite.',
    setup: {
      ...BASE_CONFIG,
      systemInstruction: {
        parts: [{ text: '' }],
      },
    },
    promptEditable: true,
  },
  'fase-3': {
    label: 'Fase 3 — Knowledge Base',
    description: 'Agente con prompt + knowledge base iniettata come contesto.',
    setup: {
      ...BASE_CONFIG,
      systemInstruction: {
        parts: [{ text: '' }],
      },
    },
    promptEditable: true,
    kbEditable: true,
  },
};

function StatusBadge({ status }) {
  const colors = {
    idle: '#555',
    connecting: '#f90',
    connected: '#0c0',
    error: '#f44',
  };
  return (
    <span style={{ background: colors[status] || '#555', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>
      {status.toUpperCase()}
    </span>
  );
}

function RawLog({ log }) {
  const ref = useRef(null);
  return (
    <div style={{ background: '#111', borderRadius: 6, padding: 8, maxHeight: 200, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace' }} ref={ref}>
      {log.length === 0 && <div style={{ color: '#555' }}>nessun messaggio</div>}
      {log.map((l, i) => (
        <div key={i} style={{ color: l.dir === '→' ? '#7bf' : '#bfb', marginBottom: 2, wordBreak: 'break-all' }}>
          <span style={{ opacity: 0.5 }}>{new Date(l.ts).toISOString().slice(11, 23)} </span>
          <strong>{l.dir} </strong>
          {l.text.slice(0, 400)}{l.text.length > 400 ? '…' : ''}
        </div>
      ))}
    </div>
  );
}

function Transcript({ transcript }) {
  return (
    <div style={{ background: '#1a1a1a', borderRadius: 6, padding: 8, maxHeight: 160, overflowY: 'auto', fontSize: 13 }}>
      {transcript.length === 0 && <div style={{ color: '#555' }}>nessuna trascrizione</div>}
      {transcript.map((t, i) => (
        <div key={i} style={{ marginBottom: 6, color: t.role === 'model' ? '#bfb' : '#7bf' }}>
          <strong>{t.role === 'model' ? 'Gemini' : 'Tu'}: </strong>{t.text}
        </div>
      ))}
    </div>
  );
}

function PhasePanel({ phaseKey, notes, onNotesChange }) {
  const cfg = PHASE_CONFIGS[phaseKey];
  const { status, transcript, rawLog, error, connect, disconnect, sendText } = useGeminiLive();
  const [prompt, setPrompt] = useState(INTERVIEW_PROMPT);
  const [kb, setKb] = useState('');
  const [textInput, setTextInput] = useState('');

  const buildSetup = () => {
    const base = JSON.parse(JSON.stringify(cfg.setup));
    if (cfg.promptEditable) {
      let instruction = prompt;
      if (cfg.kbEditable && kb.trim()) {
        instruction += `\n\n--- KNOWLEDGE BASE ---\n${kb}`;
      }
      base.systemInstruction = { parts: [{ text: instruction }] };
    }
    return base;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <StatusBadge status={status} />
        {error && <span style={{ color: '#f66', fontSize: 12 }}>{error}</span>}
      </div>

      <p style={{ color: '#aaa', fontSize: 13, margin: 0 }}>{cfg.description}</p>

      {cfg.promptEditable && (
        <div>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>System prompt</label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={3}
            style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: 6, fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
          />
        </div>
      )}

      {cfg.kbEditable && (
        <div>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Knowledge Base (testo libero)</label>
          <textarea
            value={kb}
            onChange={e => setKb(e.target.value)}
            rows={5}
            placeholder="Incolla qui il testo della knowledge base…"
            style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: 6, fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {status === 'idle' || status === 'error' ? (
          <button onClick={() => connect(buildSetup(), cfg.promptEditable ? KICKOFF : null)} style={btnStyle('#2a5')}>
            Avvia sessione
          </button>
        ) : (
          <button onClick={disconnect} style={btnStyle('#a33')}>
            Ferma sessione
          </button>
        )}
      </div>

      {status === 'connected' && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { sendText(textInput); setTextInput(''); } }}
            placeholder="Invia messaggio testo (oppure parla)…"
            style={{ flex: 1, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '6px 8px', fontSize: 13 }}
          />
          <button onClick={() => { sendText(textInput); setTextInput(''); }} style={btnStyle('#246')}>Invia</button>
        </div>
      )}

      <div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Trascrizione</div>
        <Transcript transcript={transcript} />
      </div>

      <div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Log messaggi WebSocket</div>
        <RawLog log={rawLog} />
      </div>

      <div>
        <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Note per il report</label>
        <textarea
          value={notes}
          onChange={e => onNotesChange(e.target.value)}
          rows={4}
          placeholder="Osservazioni, problemi, latenza, qualità audio…"
          style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: 6, fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
        />
      </div>
    </div>
  );
}

function ReportPanel({ notes }) {
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      await generatePDF(notes);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ color: '#aaa', fontSize: 13, margin: 0 }}>
        Completa le note nelle 3 fasi, poi genera il PDF di analisi comparativa Gemini Live API vs ElevenLabs.
      </p>

      {['fase-1', 'fase-2', 'fase-3'].map(k => (
        <div key={k} style={{ background: '#1a1a1a', borderRadius: 6, padding: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#7bf', marginBottom: 6 }}>{PHASE_CONFIGS[k].label}</div>
          <div style={{ fontSize: 13, color: '#ccc', whiteSpace: 'pre-wrap', minHeight: 40 }}>
            {notes[k] || <span style={{ color: '#555' }}>Nessuna nota</span>}
          </div>
        </div>
      ))}

      <button onClick={handleExport} disabled={exporting} style={btnStyle('#46a')}>
        {exporting ? 'Generazione…' : 'Esporta PDF'}
      </button>
    </div>
  );
}

const btnStyle = (bg) => ({
  background: bg,
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  padding: '8px 16px',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
});

export default function App() {
  const [phase, setPhase] = useState('fase-1');
  const [notes, setNotes] = useState({ 'fase-1': '', 'fase-2': '', 'fase-3': '' });

  const setNote = (k) => (v) => setNotes(prev => ({ ...prev, [k]: v }));

  return (
    <div style={{ minHeight: '100vh', background: '#0d0d0d', color: '#eee', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Gemini 2.5 Flash — Live API Test</h1>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 24 }}>Test comparativo vs ElevenLabs</p>

        <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid #333' }}>
          {PHASES.map(p => (
            <button
              key={p}
              onClick={() => setPhase(p)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: p === phase ? '2px solid #7bf' : '2px solid transparent',
                color: p === phase ? '#7bf' : '#888',
                padding: '8px 16px',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: p === phase ? 700 : 400,
                marginBottom: -1,
              }}
            >
              {p === 'report' ? 'Report PDF' : PHASE_CONFIGS[p]?.label.split(' — ')[0]}
            </button>
          ))}
        </div>

        <div>
          {phase === 'report'
            ? <ReportPanel notes={notes} />
            : <PhasePanel key={phase} phaseKey={phase} notes={notes[phase]} onNotesChange={setNote(phase)} />
          }
        </div>
      </div>
    </div>
  );
}
