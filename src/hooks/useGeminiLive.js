import { useRef, useState, useCallback } from 'react';

const OUT_RATE = 24000;

export function useGeminiLive() {
  const [status, setStatus]     = useState('idle');
  const [transcript, setTx]     = useState([]);
  const [rawLog, setRawLog]     = useState([]);
  const [error, setError]       = useState(null);

  const wsRef         = useRef(null);
  const ctxRef        = useRef(null);
  const workletRef    = useRef(null);
  const streamRef     = useRef(null);
  const nextPlayRef   = useRef(0);
  const statusRef     = useRef('idle');
  const sourcesRef    = useRef([]);   // buffer-source attivi (per barge-in)
  const setupDoneRef  = useRef(false); // setup_complete arriva 2x (sintetico + Vertex)

  const setS = (s) => { statusRef.current = s; setStatus(s); };

  const addLog = useCallback((dir, text) => {
    setRawLog(prev => [...prev, { dir, text, ts: Date.now() }].slice(-100));
  }, []);

  const addTx = useCallback((role, text) => {
    setTx(prev => [...prev, { role, text, ts: Date.now() }]);
  }, []);

  const playPCM = useCallback((b64) => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const int16 = new Int16Array(bytes.buffer);
    const f32   = Float32Array.from(int16, s => s / 32768);

    const buf = ctx.createBuffer(1, f32.length, OUT_RATE);
    buf.copyToChannel(f32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    const now   = ctx.currentTime;
    const start = Math.max(now, nextPlayRef.current);
    src.start(start);
    nextPlayRef.current = start + buf.duration;

    sourcesRef.current.push(src);
    src.onended = () => {
      sourcesRef.current = sourcesRef.current.filter(s => s !== src);
    };
  }, []);

  // BARGE-IN: l'utente parla mentre l'agente parla -> stop immediato della riproduzione.
  const stopPlayback = useCallback(() => {
    for (const s of sourcesRef.current) {
      try { s.stop(); } catch {}
    }
    sourcesRef.current = [];
    if (ctxRef.current) nextPlayRef.current = ctxRef.current.currentTime;
  }, []);

  const startMicFromStream = useCallback(async (ws, stream) => {
    streamRef.current = stream;

    const ctx = ctxRef.current;
    await ctx.audioWorklet.addModule('/audio-processor.js');

    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'pcm-processor', {
      processorOptions: { targetRate: 16000 },
    });
    workletRef.current = worklet;

    worklet.port.onmessage = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const b64 = btoa(String.fromCharCode(...new Uint8Array(e.data)));
      ws.send(JSON.stringify({
        realtime_input: {
          media_chunks: [{ mime_type: 'audio/pcm;rate=16000', data: b64 }],
        },
      }));
    };

    source.connect(worklet);
    // worklet not connected to destination — no feedback
  }, []);

  const stopMic = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    workletRef.current?.disconnect();
    streamRef.current = null;
    workletRef.current = null;
    nextPlayRef.current = 0;
  }, []);

  const connect = useCallback(async (setupConfig, kickoff = null) => {
    setS('connecting');
    setError(null);
    setTx([]);
    setRawLog([]);
    sourcesRef.current = [];
    setupDoneRef.current = false;

    // Pre-request mic so permission dialog appears before session opens
    let preStream = null;
    try {
      preStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      addLog('!', 'Mic non disponibile: ' + e.message + ' — modalità solo testo attiva');
    }

    try {
      ctxRef.current = new AudioContext();

      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${wsProto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        const msg = JSON.stringify({ setup: setupConfig });
        addLog('→', msg);
        ws.send(msg);
      };

      ws.onmessage = async (ev) => {
        addLog('←', ev.data);

        let data;
        try { data = JSON.parse(ev.data); } catch { return; }

        if (data._proxy_error) {
          setError(data._proxy_error);
          setS('error');
          return;
        }

        if (data.setupComplete !== undefined || data.setup_complete !== undefined) {
          if (setupDoneRef.current) return;  // arriva 2x: gestisci solo il primo
          setupDoneRef.current = true;
          setS('connected');
          if (preStream) {
            try { await startMicFromStream(ws, preStream); } catch (e) {
              addLog('!', 'Mic error: ' + e.message + ' — usa testo');
            }
          } else {
            addLog('!', 'Modalità solo testo — nessun mic disponibile');
          }
          // kickoff nascosto: fa parlare l'agente per primo (non mostrato in trascrizione)
          if (kickoff && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              client_content: {
                turns: [{ role: 'user', parts: [{ text: kickoff }] }],
                turn_complete: true,
              },
            }));
          }
          return;
        }

        const content = data.serverContent || data.server_content;
        if (content) {
          // BARGE-IN: il server segnala che l'utente ha interrotto
          if (content.interrupted) stopPlayback();

          // trascrizioni live (native-audio non manda testo nei parts)
          const it = content.inputTranscription || content.input_transcription;
          if (it?.text) addTx('user', it.text);
          const ot = content.outputTranscription || content.output_transcription;
          if (ot?.text) addTx('model', ot.text);

          const parts = content.modelTurn?.parts || content.model_turn?.parts || [];
          for (const p of parts) {
            if (p.text) addTx('model', p.text);
            const id = p.inlineData || p.inline_data;
            if (id?.mimeType?.startsWith('audio/pcm') || id?.mime_type?.startsWith('audio/pcm')) {
              playPCM(id.data);
            }
          }
        }
      };

      ws.onerror = () => {
        setError('WebSocket error — proxy in esecuzione?');
        setS('error');
      };

      ws.onclose = () => {
        if (statusRef.current !== 'error') setS('idle');
        stopMic();
      };

    } catch (err) {
      setError(err.message);
      setS('error');
    }
  }, [addLog, addTx, playPCM, startMicFromStream, stopMic, stopPlayback]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    stopMic();
    stopPlayback();
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setS('idle');
  }, [stopMic, stopPlayback]);

  const sendText = useCallback((text) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    addTx('user', text);
    const msg = JSON.stringify({
      client_content: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turn_complete: true,
      },
    });
    addLog('→', msg);
    ws.send(msg);
  }, [addLog, addTx]);

  return { status, transcript, rawLog, error, connect, disconnect, sendText, startMicFromStream };
}
