# Migrazione app intervista → Google Cloud Run (europe-west1, UE)

Obiettivo: spostare l'app (Express WS proxy + frontend) da Render a **Cloud Run** nella
stessa rete Google → niente blocco IP, EU-resident, WebSocket ok, scale-to-zero.

Progetto GCP: **eastern-map-380616** (lo stesso di Vertex). Region: **europe-west1**.
Runtime SA: **testvertex@eastern-map-380616.iam.gserviceaccount.com** (già ha Vertex).

---

## A. COSA SERVE DA TE (una volta sola)

`team@sharazad.com` ora NON ha permessi sul progetto. L'**owner** di `eastern-map-380616`
deve fare UNA delle due:

### Opzione 1 — login owner (più veloce, zero grant)
L'owner esegue in questa chat:
```
! gcloud auth login
```
con il proprio account. Poi deployo io tutto.

### Opzione 2 — grant ruoli a team@sharazad.com
L'owner (da Cloud Console → IAM, o gcloud) assegna a `team@sharazad.com`:

| Ruolo | A cosa serve |
|---|---|
| `roles/run.admin` | creare/gestire servizi Cloud Run |
| `roles/cloudbuild.builds.editor` | build del container (deploy --source) |
| `roles/artifactregistry.admin` | salvare l'immagine container |
| `roles/storage.admin` | bucket di staging della build |
| `roles/serviceusage.serviceUsageAdmin` | abilitare le API |
| `roles/iam.serviceAccountUser` | deployare un servizio che gira COME testvertex |

Comandi gcloud equivalenti (owner):
```
P=eastern-map-380616; M=user:team@sharazad.com
for R in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.admin roles/storage.admin roles/serviceusage.serviceUsageAdmin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding $P --member=$M --role=$R
done
```
(Alternativa "facile": `roles/editor` + `roles/run.admin` + `roles/iam.serviceAccountUser`.)

### API da abilitare (owner, o me con serviceUsageAdmin)
`run.googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`
(`aiplatform.googleapis.com` già attiva). Billing già attivo (Vertex fattura).

---

## B. COSA FACCIO IO (dopo l'accesso)

1. Deploy da sorgente (usa il `Dockerfile` già pronto):
```
gcloud config set project eastern-map-380616
gcloud run deploy gemini-live-interview \
  --source . --region europe-west1 \
  --allow-unauthenticated \
  --service-account testvertex@eastern-map-380616.iam.gserviceaccount.com \
  --timeout 3600 --port 8080 --min-instances 0 \
  --set-env-vars VERTEX_PROJECT_ID=eastern-map-380616,VERTEX_LOCATION=europe-west1,VERTEX_MODEL=gemini-live-2.5-flash-native-audio,TEXT_MODEL=gemini-2.5-flash,GEMINI_PROXY_URL=https://n8n.tacita.ai/webhook/gemini-proxy,GEMINI_AUTH_WEBHOOK=https://n8n.tacita.ai/webhook/gemini-auth-request,GEMINI_AUTH_SECRET=<secret>,MEMORIZZA_WEBHOOK=https://n8n.tacita.ai/webhook/7344ad0e-cfb8-4206-a367-895046fe3b4b
```
   - NIENTE `GOOGLE_SA_JSON`: usa la SA runtime (ADC) → token sempre valido, mai bloccato.
   - `--timeout 3600` = WS fino a 60 min (intervista lunga).
2. Ottengo l'URL Cloud Run: `https://gemini-live-interview-XXXX.europe-west1.run.app`.
3. Ripunto al nuovo URL (3 posti):
   - n8n `Gemini-test-softr — auth email`: link email → Cloud Run URL.
   - Softr FORM: `AUTH_REQUEST_URL` → Cloud Run URL; logo `img src` → Cloud Run URL.
   - Softr DETAILS (controlla email): logo `img src` → Cloud Run URL.
4. Rimuovo la diagnostica temporanea (`/api/diag` + log `[proxy][diag]`).
5. Test e2e completo dal landing.

---

## C. Dopo (opzionale, prod)
- Dominio custom (es. `intervista.tacita.ai`) mappato sul servizio Cloud Run.
- Dismettere Render (free, IP-bloccato).
- 🔴 Ruotare chiavi: n8n API, Render API, `GEMINI_AUTH_SECRET`.

## Stato attuale (2026-06-26)
- App+flusso PROVATI in UE via tunnel temporaneo (landing→form→email→intervista, campo IA).
- Bloccato SOLO l'hosting stabile UE = questo passaggio a Cloud Run.
