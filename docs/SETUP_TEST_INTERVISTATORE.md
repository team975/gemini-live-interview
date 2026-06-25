# Test intervistatore personalizzato — form Softr → Gemini Live

Flusso: **form Softr scrive record (Nome/Cognome/Ruolo/Azienda) → link con `?recordId` → app legge via PONTE n8n → riempie `{{nome}}/{{cognome}}/{{ruolo}}/{{azienda}}` nel prompt → intervista.**

Tutto NUOVO: nessun workflow attivo toccato.

## 1. n8n — importa workflow NUOVO (non tocca gli attivi)
- File: `docs/n8n-gemini-proxy-workflow.json`
- In n8n: *Import from File* → apri il nodo **Get many records** → seleziona DB **Tacita 2.0** → tabella **Test Gemini Live** (riempie il `tableId`, ora placeholder `__TABLE_ID_TEST_GEMINI_LIVE__`).
- Attiva il workflow. Webhook: `https://n8n.tacita.ai/webhook/gemini-proxy`
- Test: `curl 'https://n8n.tacita.ai/webhook/gemini-proxy?recordId=<RECORD_ID_DI_UNA_RIGA>'`
  → deve tornare `{ok:true, nome, cognome, ruolo, azienda}`.

## 2. Render — env vars (poi deploy MANUALE)
Aggiungi al service `gemini-live-interview`:
```
GEMINI_PROXY_URL=https://n8n.tacita.ai/webhook/gemini-proxy
```
(Opzionali, se proteggi il webhook con header auth — il valore resta SOLO server-side:)
```
GEMINI_PROXY_AUTH_HEADER_NAME=<nome header>
GEMINI_PROXY_AUTH_HEADER_VALUE=<valore>
```
Deploy: ⚠️ autoDeploy OFF → git push NON rideploya. Trigger manuale (dashboard Manual Deploy o API).

## 3. Softr — form + bottone
- **Form** sulla tabella `Test Gemini Live`: campi Nome, Cognome, Ruolo, Azienda. Al submit crea la riga (Record ID auto).
- **Bottone/link** verso l'app col Record ID della riga:
  `https://gemini-live-interview.onrender.com/?recordId={RECORD_ID}`
  (in Softr usa il magic field del Record ID della riga corrente).

## 4. Verifica end-to-end
1. Compila form → riga creata.
2. Apri il link → l'app mostra banner **"Intervista per Nome Cognome (Ruolo · Azienda)"** e brief precompilato.
3. Avvia → l'AI apre con **"Ciao {Nome}!"** e conosce ruolo/azienda.

## Note tecniche
- App legge `?recordId` (o `?id`) → `GET /api/interview` → proxy n8n → Softr getMany + match by Record ID.
- Placeholder riempiti sia in Intro (visibile) sia a runtime (`buildSetup`), idempotente.
- Lato lettura = server-side (proxy.js, Render UE): l'eventuale auth header non finisce nel browser.
- Scaling: ora getMany su tutta la tabella + match in Code (ok per test). Per molte righe → getOne by Record ID.
