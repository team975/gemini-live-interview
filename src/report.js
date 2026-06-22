import { jsPDF } from 'jspdf';

const SECTIONS = [
  {
    title: 'Analisi: Gemini 2.5 Flash Live API vs ElevenLabs',
    subtitle: 'Risultati test — ' + new Date().toLocaleDateString('it-IT'),
  },
];

const PRO_CONTRO = {
  pro: [
    'Audio nativo generato dal modello (nessun TTS separato)',
    'Multimodale: testo + audio in un unico endpoint',
    'Costo potenzialmente inferiore (no TTS + LLM separati)',
    'Knowledge base iniettabile via system_instruction',
    'Gestione del contesto conversazionale nativa',
    'EU-compliant tramite Vertex AI (region europea disponibile)',
  ],
  contro: [
    'Setup più complesso (Vertex AI auth, service account)',
    'WebSocket proxy backend obbligatorio (no client-only)',
    'Latenza variabile — da verificare in produzione',
    'Voci meno personalizzabili rispetto a ElevenLabs',
    'SDK meno maturo per browser rispetto a @elevenlabs/react',
    'Nessun supporto nativo per clonazione voce',
  ],
  difficolta: [
    'Autenticazione Vertex AI: service account + token refresh',
    'Proxy WebSocket: necessario in produzione (Vercel Fluid Compute o servizio dedicato)',
    'Audio worklet: gestione sample rate e resampling',
    'Formato messaggi: snake_case vs camelCase da verificare empiricamente',
    'Nome modello esatto per native audio: da confermare in console',
  ],
};

export async function generatePDF(notes) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210;
  const MARGIN = 20;
  const CONTENT_W = W - MARGIN * 2;
  let y = MARGIN;

  const nl = (h = 6) => { y += h; };
  const checkPage = (needed = 10) => {
    if (y + needed > 280) { doc.addPage(); y = MARGIN; }
  };

  // Title
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('Gemini 2.5 Flash Live API', MARGIN, y);
  nl(8);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);
  doc.text('Analisi comparativa vs ElevenLabs — ' + new Date().toLocaleDateString('it-IT'), MARGIN, y);
  nl(12);
  doc.setTextColor(0, 0, 0);

  // Divider
  doc.setDrawColor(200, 200, 200);
  doc.line(MARGIN, y, W - MARGIN, y);
  nl(8);

  // Phase notes
  const phases = [
    { key: 'fase-1', label: 'Fase 1 — Connessione Base' },
    { key: 'fase-2', label: 'Fase 2 — Prompt Specifico' },
    { key: 'fase-3', label: 'Fase 3 — Knowledge Base' },
  ];

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Osservazioni dai Test', MARGIN, y);
  nl(8);

  for (const p of phases) {
    checkPage(20);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(40, 80, 160);
    doc.text(p.label, MARGIN, y);
    nl(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(10);
    const text = notes[p.key]?.trim() || '(nessuna nota inserita)';
    const lines = doc.splitTextToSize(text, CONTENT_W);
    checkPage(lines.length * 5 + 4);
    doc.text(lines, MARGIN, y);
    y += lines.length * 5;
    nl(8);
  }

  // Divider
  checkPage(15);
  doc.setDrawColor(200, 200, 200);
  doc.line(MARGIN, y, W - MARGIN, y);
  nl(10);

  // Pro / Contro
  const printList = (title, items, color) => {
    checkPage(15);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...color);
    doc.text(title, MARGIN, y);
    nl(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(10);
    for (const item of items) {
      checkPage(8);
      const lines = doc.splitTextToSize('• ' + item, CONTENT_W - 4);
      doc.text(lines, MARGIN + 2, y);
      y += lines.length * 5;
      nl(2);
    }
    nl(4);
  };

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 0, 0);
  doc.text('Analisi Generale', MARGIN, y);
  nl(8);

  printList('Vantaggi (Pro)', PRO_CONTRO.pro, [30, 130, 60]);
  printList('Svantaggi (Contro)', PRO_CONTRO.contro, [180, 60, 40]);
  printList('Difficoltà di Implementazione', PRO_CONTRO.difficolta, [100, 60, 160]);

  // Footer
  checkPage(15);
  doc.setDrawColor(200, 200, 200);
  doc.line(MARGIN, y, W - MARGIN, y);
  nl(6);
  doc.setFontSize(9);
  doc.setTextColor(150, 150, 150);
  doc.text('Generato da Sharazad — gemini-live-test — ' + new Date().toISOString(), MARGIN, y);

  doc.save('gemini-live-api-analisi.pdf');
}
