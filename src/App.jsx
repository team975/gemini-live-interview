import { useState, useRef, useEffect } from 'react';
import { useGeminiLive } from './hooks/useGeminiLive';

const KICKOFF = 'Inizia ora la conversazione con il tuo messaggio di apertura.';

// Pagina iniziale (root, senza recordId) -> manda al form Softr.
// Il form crea il record, invia la mail col link ?recordId che riporta qui personalizzato.
const FORM_URL = 'https://yajaira65701.softr.app/form-test-gemini?autoUser=true';
const LOGO_URL = '/sharazad-logo.png';

// Brief di default (persona + obiettivo + apertura). Editabile a inizio sessione:
// quando cambia la KB, qui si cambia anche scopo e frase d'apertura.
const DEFAULT_BRIEF = `Sei un intervistatore AI. Conduci una conversazione vocale per esplorare come la persona usa l'intelligenza artificiale nel lavoro e nella vita quotidiana in generale.

PROFILO INTERVISTATO (dati forniti prima dell'intervista):
- Nome: {{nome}} {{cognome}}
- Ruolo: {{ruolo}}
- Azienda: {{azienda}}
Usa questi dati per personalizzare apertura e domande. Se un dato è vuoto, non inventarlo.

REGOLA SUL PRIMO MESSAGGIO (vincolante):
Il tuo primissimo turno parlato deve essere ESATTAMENTE, parola per parola, questo:
"Ciao {{nome}}! Sono un intervistatore AI. Vorrei farti qualche domanda su come usi l'intelligenza artificiale nel lavoro e nella vita di tutti i giorni. Non ci sono risposte giuste o sbagliate, mi interessa la tua esperienza. Per iniziare: di cosa ti occupi, e ti capita di usare strumenti di AI?"

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

const KB_INSTRUCTION = `KNOWLEDGE BASE:
Hai a disposizione lo strumento "cerca_kb" che interroga una knowledge base specifica fornita per questa intervista. Usalo PRIMA di porre domande o fare affermazioni su fatti specifici (azienda, prodotto, persona, contesto): cerca l'argomento, poi formula la domanda ancorata a ciò che emerge. Non inventare dettagli che non risultano dalla knowledge base; se qualcosa non c'è, chiedilo alla persona.`;

// Riempie i placeholder {{nome}} {{cognome}} {{ruolo}} {{azienda}} coi dati del record Softr.
// Se un dato manca, lo lascia vuoto e ripulisce gli artefatti ("Ciao !", spazi doppi).
function fillBrief(brief, p = {}) {
  const v = { nome: p.nome || '', cognome: p.cognome || '', ruolo: p.ruolo || '', azienda: p.azienda || '' };
  return brief
    .replace(/\{\{(nome|cognome|ruolo|azienda)\}\}/g, (_, k) => v[k])
    .replace(/Ciao !/g, 'Ciao!')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([!?.,;:])/g, '$1');
}

// Costruisce il setup Live in base alla modalità. Live è mono-modalità per sessione:
// voce -> AUDIO (+ trascrizione + voce); testo -> TEXT (niente audio).
function buildSetup(mode, hasKB, brief) {
  const sys = (brief?.trim() || DEFAULT_BRIEF) + (hasKB ? '\n\n' + KB_INSTRUCTION : '');
  const common = {
    systemInstruction: { parts: [{ text: sys }] },
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: {},
  };
  if (mode === 'text') return { ...common, responseModalities: ['TEXT'] };
  return {
    ...common,
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

const C = {
  ink: 'var(--ink)', muted: 'var(--muted)', faint: 'var(--faint)',
  indigo: 'var(--indigo)', indigoDk: 'var(--indigo-dk)', lime: 'var(--lime)',
  bg: 'var(--bg)', lav: 'var(--lav)', border: 'var(--border)', navy: 'var(--navy)', white: 'var(--white)',
};

function Wordmark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: 30, height: 30, borderRadius: 9, background: C.indigo,
        display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 17,
        boxShadow: '0 4px 12px rgba(84,81,208,0.35)',
      }}>t</div>
      <span style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.02em' }}>tacita</span>
      <span style={{
        fontSize: 11, fontWeight: 700, color: C.indigoDk, background: C.lav,
        padding: '2px 8px', borderRadius: 999, marginLeft: 2,
      }}>DEMO</span>
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <div style={{
        flex: '0 0 auto', width: 28, height: 28, borderRadius: '50%',
        background: C.indigo, color: '#fff', fontWeight: 700, fontSize: 14,
        display: 'grid', placeItems: 'center',
      }}>{n}</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
        <div style={{ color: C.muted, fontSize: 14 }}>{children}</div>
      </div>
    </div>
  );
}

function Pill({ children }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600,
      color: C.indigoDk, background: C.lav, padding: '6px 12px', borderRadius: 999,
    }}>{children}</span>
  );
}

function ModeCard({ active, onClick, icon, title, desc }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, textAlign: 'left', padding: '14px 16px', borderRadius: 14, cursor: 'pointer',
      border: `2px solid ${active ? C.indigo : C.border}`,
      background: active ? C.lav : '#fff',
      boxShadow: active ? '0 6px 18px -10px rgba(84,81,208,0.5)' : 'none',
    }}>
      <div style={{ fontSize: 22, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: active ? C.indigoDk : C.ink }}>{title}</div>
      <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>{desc}</div>
    </button>
  );
}

function Intro({ onStart, profile }) {
  const initialBrief = profile?.ok ? fillBrief(DEFAULT_BRIEF, profile) : DEFAULT_BRIEF;
  const [mode, setMode] = useState('voice');
  const [kb, setKb] = useState('');
  const [brief, setBrief] = useState(initialBrief);
  const fileRef = useRef(null);
  const fullName = [profile?.nome, profile?.cognome].filter(Boolean).join(' ');
  const profileLine = [profile?.ruolo, profile?.azienda].filter(Boolean).join(' · ');

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { setKb(await f.text()); } catch {}
  };

  return (
    <div className="fade-up" style={{ maxWidth: 720, margin: '0 auto', padding: '28px 20px 56px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
        <Wordmark />
      </div>

      {profile?.ok && fullName && (
        <div style={{
          background: C.navy, color: '#fff', borderRadius: 16, padding: '14px 18px', marginBottom: 18,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 22 }}>👤</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Intervista per {fullName}</div>
            {profileLine && <div style={{ fontSize: 13, color: '#aeb4c8', marginTop: 2 }}>{profileLine}</div>}
          </div>
        </div>
      )}

      <div style={{
        background: C.white, border: `1px solid ${C.border}`, borderRadius: 24,
        padding: 'clamp(24px, 4vw, 40px)', boxShadow: '0 18px 50px -24px rgba(21,25,39,0.25)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.12em', color: C.indigo, marginBottom: 12 }}>
          TEST · INTERVISTA VOCALE AI
        </div>
        <h1 style={{ fontSize: 'clamp(26px, 5vw, 36px)', lineHeight: 1.12, letterSpacing: '-0.02em', marginBottom: 14 }}>
          Parla con un intervistatore AI
        </h1>
        <p style={{ fontSize: 16.5, color: C.muted, marginBottom: 22 }}>
          Stiamo testando un <strong style={{ color: C.ink }}>intervistatore vocale basato su intelligenza artificiale</strong>.
          Ti farà qualche domanda — a voce, in italiano — su <strong style={{ color: C.ink }}>come usi l'AI nel
          lavoro e nella vita di tutti i giorni</strong>. È una chiacchierata naturale: rispondi come ti viene,
          non ci sono risposte giuste o sbagliate.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 26 }}>
          <Pill>⏱️ 10–30 minuti</Pill>
          <Pill>🎙️ Serve il microfono</Pill>
          <Pill>🎧 Cuffie consigliate</Pill>
          <Pill>🇮🇹 In italiano</Pill>
        </div>

        <div style={{ fontWeight: 800, fontSize: 13, letterSpacing: '0.06em', color: C.faint, marginBottom: 14 }}>
          COME FUNZIONA
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 26 }}>
          <Step n={1} title="Avvia e consenti il microfono">
            Premi “Inizia l'intervista”. Il browser ti chiederà l'accesso al microfono: premi <strong>Consenti</strong>.
          </Step>
          <Step n={2} title="Lascia parlare per primo l'intervistatore">
            Dopo qualche secondo l'AI ti saluterà e farà la prima domanda. Aspetta che finisca, poi rispondi a voce.
          </Step>
          <Step n={3} title="Conversa come al telefono">
            Parla in modo naturale, una persona alla volta. Puoi <strong>interromperlo</strong> mentre parla, proprio
            come in una telefonata. Se preferisci, puoi anche scrivere nel riquadro di testo.
          </Step>
          <Step n={4} title="Chiudi quando vuoi">
            Quando hai finito premi “Termina intervista”. Vedrai la trascrizione man mano che parlate.
          </Step>
        </div>

        <div style={{
          background: C.lav, borderRadius: 14, padding: '14px 16px', fontSize: 13.5, color: C.muted, marginBottom: 26,
        }}>
          🔒 <strong style={{ color: C.ink }}>Privacy:</strong> è un test. La voce viene elaborata su server in
          Unione Europea. Per favore <strong style={{ color: C.ink }}>non condividere dati personali sensibili</strong>
          {' '}(tuoi o altrui): nomi di clienti, dati riservati, ecc. Parla pure liberamente del tuo modo di usare l'AI.
        </div>

        <div style={{ fontWeight: 800, fontSize: 13, letterSpacing: '0.06em', color: C.faint, marginBottom: 12 }}>
          MODALITÀ
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 22 }}>
          <ModeCard active={mode === 'voice'} onClick={() => setMode('voice')}
            icon="🎙️" title="Voce" desc="Parli e ascolti. Serve il microfono." />
          <ModeCard active={mode === 'text'} onClick={() => setMode('text')}
            icon="⌨️" title="Testo" desc="Scrivi e leggi. Niente audio." />
        </div>

        <div style={{ fontWeight: 800, fontSize: 13, letterSpacing: '0.06em', color: C.faint, marginBottom: 8 }}>
          KNOWLEDGE BASE <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>(facoltativa)</span>
        </div>
        <div style={{ fontSize: 13.5, color: C.muted, marginBottom: 10 }}>
          Incolla qui il contesto su cui l'intervistatore deve basarsi (azienda, prodotto, persona…).
          Lo userà per ancorare le domande ai fatti reali.
        </div>
        <textarea
          value={kb}
          onChange={e => setKb(e.target.value)}
          placeholder="Incolla qui la knowledge base… (oppure carica un file)"
          rows={5}
          style={{
            width: '100%', padding: '12px 14px', borderRadius: 12, border: `1px solid ${C.border}`,
            fontSize: 14, fontFamily: 'inherit', resize: 'vertical', outline: 'none', color: C.ink, marginBottom: 10,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 26 }}>
          <input ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain" onChange={onFile} style={{ display: 'none' }} />
          <button onClick={() => fileRef.current?.click()} style={{
            padding: '8px 14px', borderRadius: 10, background: '#fff', border: `1px solid ${C.border}`,
            color: C.indigoDk, fontWeight: 700, fontSize: 13,
          }}>📎 Carica file (.txt/.md)</button>
          {kb.trim() && (
            <span style={{ fontSize: 12.5, color: C.muted }}>
              {kb.length.toLocaleString('it-IT')} caratteri · <button onClick={() => setKb('')}
                style={{ color: '#b3261e', fontWeight: 700, background: 'none', padding: 0 }}>rimuovi</button>
            </span>
          )}
        </div>

        <details style={{ marginBottom: 26 }}>
          <summary style={{
            fontWeight: 800, fontSize: 13, letterSpacing: '0.06em', color: C.faint, cursor: 'pointer', marginBottom: 8,
          }}>
            BRIEF INTERVISTA <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>(persona, obiettivo, frase d'apertura — modifica per scenario)</span>
          </summary>
          <div style={{ fontSize: 13.5, color: C.muted, margin: '8px 0 10px' }}>
            Definisce chi è l'intervistatore, cosa vuole scoprire e come apre. Cambialo quando cambi knowledge base,
            così scopo e apertura restano coerenti. La KB invece resta solo nel riquadro sopra (l'AI la consulta al volo).
          </div>
          <textarea
            value={brief}
            onChange={e => setBrief(e.target.value)}
            rows={10}
            style={{
              width: '100%', padding: '12px 14px', borderRadius: 12, border: `1px solid ${C.border}`,
              fontSize: 13.5, fontFamily: 'inherit', resize: 'vertical', outline: 'none', color: C.ink,
            }}
          />
          <button onClick={() => setBrief(initialBrief)} style={{
            marginTop: 8, padding: '6px 12px', borderRadius: 9, background: '#fff', border: `1px solid ${C.border}`,
            color: C.indigoDk, fontWeight: 700, fontSize: 12.5,
          }}>↺ Ripristina default</button>
        </details>

        <button onClick={() => onStart(mode, kb, brief)} style={{
          width: '100%', padding: '16px 22px', borderRadius: 14, background: C.indigo, color: '#fff',
          fontSize: 17, fontWeight: 700, boxShadow: '0 12px 26px -10px rgba(84,81,208,0.6)',
          transition: 'transform .08s ease',
        }}
          onMouseDown={e => e.currentTarget.style.transform = 'scale(0.99)'}
          onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
          onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
        >
          {mode === 'voice' ? "🎙️ Inizia l'intervista (voce)" : "⌨️ Inizia l'intervista (testo)"}
        </button>
        <div style={{ textAlign: 'center', fontSize: 12.5, color: C.faint, marginTop: 12 }}>
          Al primo avvio può servire qualche secondo per attivarsi. Funziona meglio su Chrome.
        </div>
      </div>

      <div style={{ textAlign: 'center', fontSize: 12.5, color: C.faint, marginTop: 22 }}>
        Demo Tacita · voce elaborata in UE (Google Vertex AI, europe-west1)
      </div>
    </div>
  );
}

function StatusLine({ status, mode }) {
  const map = {
    connecting: { dots: true, text: 'Sto preparando l\'intervista…', color: C.indigo },
    connected:  { dots: false, text: mode === 'text' ? 'Pronto — scrivi pure' : 'In ascolto — parla pure', color: '#1a7a3c' },
    error:      { dots: false, text: 'Si è verificato un problema', color: '#b3261e' },
    idle:       { dots: false, text: 'Intervista terminata', color: C.faint },
  };
  const s = map[status] || map.idle;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', color: s.color, fontWeight: 600 }}>
      {status === 'connected' && (
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#1a7a3c', display: 'inline-block' }} />
      )}
      <span>{s.text}</span>
      {s.dots && <span><span className="dot" /><span className="dot" /><span className="dot" /></span>}
    </div>
  );
}

function Interview({ mode, kb, brief, profile, onExit }) {
  const { status, transcript, error, connect, disconnect, sendText } = useGeminiLive();
  const [text, setText] = useState('');
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const started = useRef(false);
  const isText = mode === 'text';

  useEffect(() => {
    if (!started.current) {
      started.current = true;
      // Riempi i placeholder coi dati del record (idempotente: se già pieni, no-op).
      const finalBrief = fillBrief(brief, profile || {});
      connect({ setup: buildSetup(mode, !!(kb || '').trim(), finalBrief), kickoff: KICKOFF, mode, kb });
    }
  }, [connect, mode, kb, brief, profile]);

  useEffect(() => {
    if (isText && status === 'connected') inputRef.current?.focus();
  }, [isText, status]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [transcript]);

  const stop = () => { disconnect(); onExit(); };

  return (
    <div className="fade-up" style={{ maxWidth: 720, margin: '0 auto', padding: '24px 20px 40px', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <Wordmark />
        <button onClick={stop} style={{
          padding: '9px 16px', borderRadius: 10, background: '#fff', border: `1px solid ${C.border}`,
          color: '#b3261e', fontWeight: 700, fontSize: 13.5,
        }}>Termina intervista</button>
      </div>

      <div style={{
        background: C.navy, borderRadius: 20, padding: '26px 20px', textAlign: 'center', marginBottom: 16,
        color: '#fff',
      }}>
        <div style={{
          width: 92, height: 92, borderRadius: '50%', margin: '0 auto 16px',
          background: 'linear-gradient(135deg, #6c69e6, #403cb8)',
          display: 'grid', placeItems: 'center', fontSize: 38,
          animation: (status === 'connected' && !isText) ? 'pulse 2s infinite' : 'none',
        }}>{isText ? '💬' : '🎙️'}</div>
        <div style={{ filter: 'invert(0)' }}>
          <StatusLine status={status} mode={mode} />
        </div>
        {status === 'connected' && (
          <div style={{ fontSize: 13, color: '#aeb4c8', marginTop: 10 }}>
            {isText
              ? 'Scrivi qui sotto e premi Invio. Risponde a schermo.'
              : 'Puoi interromperlo mentre parla. Una persona alla volta.'}
          </div>
        )}
        {status === 'error' && error && (
          <div style={{ fontSize: 13, color: '#ffb4ac', marginTop: 10 }}>{error}</div>
        )}
      </div>

      <div ref={scrollRef} style={{
        flex: 1, minHeight: 220, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 16,
        padding: 16, overflowY: 'auto', marginBottom: 14,
      }}>
        {transcript.length === 0 ? (
          <div style={{ color: C.faint, fontSize: 14, textAlign: 'center', padding: '40px 10px' }}>
            La trascrizione comparirà qui mentre parlate.
          </div>
        ) : transcript.map((t, i) => {
          const me = t.role === 'user';
          return (
            <div key={i} style={{ display: 'flex', justifyContent: me ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
              <div style={{
                maxWidth: '82%', padding: '9px 13px', borderRadius: 14, fontSize: 14.5,
                background: me ? C.indigo : C.lav, color: me ? '#fff' : C.ink,
                borderBottomRightRadius: me ? 4 : 14, borderBottomLeftRadius: me ? 14 : 4,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, opacity: .7, marginBottom: 2 }}>
                  {me ? 'Tu' : 'Intervistatore'}
                </div>
                {t.text}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          ref={inputRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && text.trim()) { sendText(text); setText(''); } }}
          placeholder={isText ? 'Scrivi il tuo messaggio…' : 'Oppure scrivi qui (facoltativo)…'}
          disabled={status !== 'connected'}
          style={{
            flex: 1, padding: '12px 14px', borderRadius: 12, border: `1px solid ${C.border}`,
            fontSize: 14.5, background: status === 'connected' ? '#fff' : '#f2f3f7', color: C.ink, outline: 'none',
          }}
        />
        <button
          onClick={() => { if (text.trim()) { sendText(text); setText(''); } }}
          disabled={status !== 'connected' || !text.trim()}
          style={{
            padding: '12px 20px', borderRadius: 12, background: C.indigo, color: '#fff', fontWeight: 700,
            fontSize: 14.5, opacity: (status === 'connected' && text.trim()) ? 1 : 0.5,
          }}
        >Invia</button>
      </div>
    </div>
  );
}

// Pagina iniziale: spiega il test e manda al form Softr (dove inserisci i dati).
function Landing() {
  return (
    <div className="fade-up" style={{ maxWidth: 640, margin: '0 auto', padding: '32px 20px 56px' }}>
      <img src={LOGO_URL} alt="Sharazad" style={{ height: 40, width: 'auto', marginBottom: 28 }} />
      <div style={{
        background: C.white, border: `1px solid ${C.border}`, borderRadius: 24,
        padding: 'clamp(24px, 4vw, 40px)', boxShadow: '0 18px 50px -24px rgba(21,25,39,0.25)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.12em', color: C.indigo, marginBottom: 12 }}>
          TEST · INTERVISTA VOCALE AI
        </div>
        <h1 style={{ fontSize: 'clamp(26px, 5vw, 36px)', lineHeight: 1.12, letterSpacing: '-0.02em', marginBottom: 14 }}>
          Parla con un intervistatore AI
        </h1>
        <p style={{ fontSize: 16.5, color: C.muted, marginBottom: 22 }}>
          Un <strong style={{ color: C.ink }}>intervistatore vocale AI</strong> ti farà qualche domanda — a voce, in italiano —
          su come usi l'AI nel lavoro e nella vita. Prima inserisci i tuoi dati: l'intervista verrà
          <strong style={{ color: C.ink }}> personalizzata</strong> sul tuo profilo. Riceverai il link via email.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 26 }}>
          <Pill>⏱️ 10–30 minuti</Pill>
          <Pill>🎙️ Serve il microfono</Pill>
          <Pill>📧 Link via email</Pill>
          <Pill>🇮🇹 In italiano</Pill>
        </div>
        <div style={{ background: C.lav, borderRadius: 14, padding: '14px 16px', fontSize: 13.5, color: C.muted, marginBottom: 26 }}>
          🔒 <strong style={{ color: C.ink }}>Privacy:</strong> test interno. La voce è elaborata su server in
          Unione Europea. Accesso riservato agli indirizzi <strong style={{ color: C.ink }}>@sharazad.com</strong>.
        </div>
        <a href={FORM_URL} style={{
          display: 'block', textAlign: 'center', width: '100%', padding: '16px 22px', borderRadius: 14,
          background: C.indigo, color: '#fff', fontSize: 17, fontWeight: 700, textDecoration: 'none',
          boxShadow: '0 12px 26px -10px rgba(84,81,208,0.6)',
        }}>Inizia → inserisci i tuoi dati</a>
      </div>
      <div style={{ textAlign: 'center', fontSize: 12.5, color: C.faint, marginTop: 22 }}>
        Tecnologia Sharazad · voce elaborata in UE (Google Vertex AI, europe-west1)
      </div>
    </div>
  );
}

export default function App() {
  const rid = new URLSearchParams(location.search).get('recordId')
    || new URLSearchParams(location.search).get('id');
  const [cfg, setCfg] = useState(null);          // null = schermata intro
  const [profile, setProfile] = useState(null);  // dati intervistato da Softr (via recordId)
  const [loading, setLoading] = useState(!!rid);

  // Con ?recordId (link dalla mail): leggi i dati dell'intervistato dal proxy.
  useEffect(() => {
    if (!rid) return;
    fetch('/api/interview?recordId=' + encodeURIComponent(rid))
      .then(r => r.json())
      .then(d => setProfile(d?.ok ? d : { ok: false, error: d?.error || 'fetch_failed' }))
      .catch(e => setProfile({ ok: false, error: e.message }))
      .finally(() => setLoading(false));
  }, [rid]);

  // Senza recordId = pagina iniziale (root): porta al form Softr.
  if (!rid) return <Landing />;

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="dot" /><div className="dot" /><div className="dot" />
          <div style={{ marginTop: 12 }}>Carico i dati dell'intervista…</div>
        </div>
      </div>
    );
  }

  return !cfg
    ? <Intro profile={profile} onStart={(mode, kb, brief) => setCfg({ mode, kb, brief })} />
    : <Interview mode={cfg.mode} kb={cfg.kb} brief={cfg.brief} profile={profile} onExit={() => setCfg(null)} />;
}
