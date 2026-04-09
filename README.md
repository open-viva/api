# 🚀 cvv api (wrapper locale per classeviva)

api locale basata su **node.js** ed **express** progettata per semplificare l'integrazione con gli endpoint ufficiali di classeviva.

🔗 **riferimenti endpoint:**
- [classeviva-official-endpoints](https://github.com/lioydiano/classeviva-official-endpoints)
- [open-viva-endpoints](https://github.com/open-viva/endpoints)

---

## ✨ cosa puoi fare
- 🔐 **login semplificato**: gestione automatica dell'autenticazione tramite `post /rest/v1/auth/login`.
- 💾 **sessione in memoria**: salva i dati della sessione localmente (chiave `x-session-id`).
- 🤖 **auto-login**: accesso agli endpoint protetti usando direttamente `username/password` o `uid/password` se la sessione non è attiva.
- 📂 **dati pronti all'uso**: accesso rapido a voti, lezioni, agenda, assenze, note e bacheca.
- 📄 **documenti**: download diretto dei pdf e gestione della didattica.
- 🛠️ **modalità raw**: accesso diretto a qualsiasi endpoint ufficiale non ancora mappato.

---

## 🛠️ requisiti
- **node.js** 18 o superiore

---

## 🏁 come iniziare

1. **installa le dipendenze**
   ```bash
   npm install
   ```
2. **configura l'ambiente**
   ```bash
   cp .env.example .env
   ```
3. **accendi il server**
   ```bash
   npm run start
   ```
   > il server sarà attivo di default su: `http://localhost:3000`

---

## 🔐 gestione login e sessioni

### 🔑 login standard
`post /api/login`
invia un body json con `username` (o `uid`) e `password`. riceverai un `sessionid` da usare negli header delle chiamate successive come `x-session-id`.

### 🔄 login automatico
non vuoi gestire il token? puoi inviare le credenziali direttamente agli endpoint dei dati tramite:
- **body json**: `{"username": "...", "password": "..."}`
- **query string**: `?username=...&password=...`

l'api effettuerà il login per te, creerà la sessione e restituirà i dati insieme al nuovo `sessionid`.

---

## 🛣️ endpoint disponibili

### 📊 didattica e voti
- `get /api/grades` → tutti i voti
- `get /api/grades/average` → medie calcolate (totali, per periodo o materia)
- `get /api/subjects` → elenco materie
- `get /api/periods` → periodi didattici (quadrimestri/trimestri)

### 📅 registro e agenda
- `get /api/lessons` → lezioni (usa i parametri `day` o `start/end`)
- `get /api/agenda` → compiti e verifiche (filtra con `begin/end` e `eventcode`)
- `get /api/calendar` → calendario scolastico

### 📝 assenze e note
- `get /api/absences` → elenco assenze, ritardi e uscite
- `get /api/notes` → note disciplinari
- `post /api/notes/read` → segna le note come lette

### 📂 bacheca e documenti
- `get /api/noticeboard` → circolari e comunicazioni
- `get /api/noticeboard/download/:pubId/:attachNum` → scarica allegato circolare
- `get /api/didactics` → materiali caricati dai docenti
- `get /api/documents` → elenco documenti personali
- `get /api/documents/download/:hash` → scarica documento personale (non circolare)

### 🛠️ utility
- `get /api/overview` → riassunto generale del profilo
- `post /api/raw` → chiama un endpoint a scelta (es. `{"method": "get", "path": "/v1/..."}`)
- `get /health` → verifica se il server è online

### 🧮 compatibilità chemediaho
- `post /api/chemediaho/logout`
- `get /api/chemediaho/export`
- `get /api/chemediaho/settings`
- `get /api/chemediaho/overall_average_detail`
- `post /api/chemediaho/set_blue_grade_preference`
- `post /api/chemediaho/calculate_goal`
- `post /api/chemediaho/predict_average`
- `post /api/chemediaho/calculate_goal_overall`
- `post /api/chemediaho/predict_average_overall`
- `post /api/chemediaho/export/csv`

questi endpoint usano la stessa sessione locale (`x-session-id`) e lo stesso auto-login con `username/password`.

---

## 💻 esempi veloci con curl

### 1. recuperare i voti (con auto-login, senza passare da /api/login)
```bash
curl -x post http://localhost:3000/api/grades \
  -h "content-type: application/json" \
  -d '{"username":"s1234567i","password":"la_tua_password"}'
```

### 2. scaricare una circolare dalla bacheca
```bash
curl -L "http://localhost:3000/api/noticeboard/download/PUB_ID/ATTACH_NUM" \
  -h "x-session-id: il_tuo_session_id" \
   --output circolare.pdf
```

> `PUB_ID` e `ATTACH_NUM` li trovi in `GET /api/noticeboard`.
> Ogni allegato include anche `attachments[].downloadUrl` pronto da usare.

---

## ⚙️ note tecniche
- 🧠 **memoria**: le sessioni sono volatili. se riavvii il server, dovrai rifare il login.
- 🆔 **student id**: viene estratto automaticamente dal campo `ident` durante il login.
- 📱 **emulazione**: l'api si identifica ai server classeviva come un dispositivo android (versione 4.1.7).
- ✅ **header obbligatori**: verso classeviva vengono inviati automaticamente `z-dev-apikey` e i token necessari.

---

### ✅ status del server
per controllare che tutto funzioni, visita: `http://localhost:3000/health`