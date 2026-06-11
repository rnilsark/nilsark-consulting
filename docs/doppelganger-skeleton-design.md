# Doppelgänger — Spec: körbart skelett (milstolpe 1)

> Status: **låst design**, redo för implementationsplan. Datum: 2026-06-11.
> Scope: det tunnaste *körbara* skelettet end-to-end (motsvarar dokumentets Uppgift 1+2).
> Allt utanför scope listas explicit under **Medvetet bortvalt nu**.

## Syfte i en mening
Bevisa hela kedjan `schedule → kö → dispatcher → worker → claude -p → events` med
**en** roll (`planner`) som producerar en morgon-brief över två kalendrar — så att allt
därefter blir "lägg till en agentmapp + en adapter".

---

## Designprinciper (lastbärande)
- **Ingen färdig plattform.** `claude -p` är motorn. Allt annat är tunn, *dum* limkod.
- **All intelligens i agenterna.** Dispatcher/adaptrar/worker delar bara ut/in arbete och loggar.
- **Tillstånd är filer och DB-rader, inte processer.** Agenter är tillståndslösa; allt de "vet"
  läses ur fil/DB och injiceras i prompten vid varje körning.
- **Pollning är gratis så länge ingen LLM är i loopen.** Väck aldrig en LLM för att *upptäcka*
  arbete — bara för att *utföra* det.
- **Agent = säkerhetsgräns.** En roll = en katalog med egen identitet/kontext/behörigheter.

---

## Repo-placering & struktur (LÅST)
Doppelgänger är **inte** en plugin — det är runtimen som *kör* roller. Den bor som subfolder
i detta plugin-marketplace-repo (`nilsark-consulting`). `marketplace.json` är en allowlist;
en omappad `doppelganger/`-mapp är osynlig för plugin-systemet → ingen kollision.

```
doppelganger/
  package.json            TS: better-sqlite3, vite
  schema.sql              queue + events, WAL
  src/
    types.ts              QueueRow, EventRow, Agent  ← delas backend + FE
    config.ts             läser DOPPELGANGER_HOME, kalender-ID:n, intervall ur env
    db.ts                 öppna DB + WAL + prepared statements
    index.ts              entrypoint: startar dispatcher-loop + scheduler i EN process
    dispatcher.ts         loop ~5s: städa → plocka → starta worker (blockerar aldrig)
    worker.ts             kör claude -p → läs out.json → en transaktion
    scheduler.ts          kör adaptrarnas pollar på intervall (node-cron) — ingen OS-cron
    adapters/
      schedule.ts         lägger planner/morning_brief enligt tidtabell
  agents/                 ← claude -p-ARBETSKATALOGER (≠ .claude/agents-subagenter)
    planner/
      CLAUDE.md           identitet + kalenderkarta
      .claude/skills/morning-brief/SKILL.md
  registry.yaml           sanningskälla: agenter + can_be_called_by
  deploy/                 systemd .service-template + install.sh (en unit, ingen cron)
```

> Runtime-state (SQLite, `out.json`, briefer, OAuth-tokens) ligger **inte** i repot utan i
> `$DOPPELGANGER_HOME` (se Drift & deploy). Repot = bara kod.

### Begreppsklargörande (viktigt — två olika mekanismer)
- **Claude Code-subagent** (`nilsark/agents/cfo.md`): frontmatter, invokeras *interaktivt*. Rör vi inte.
- **Doppelgänger-"agent"** (`doppelganger/agents/planner/`): en **katalog** som workern gör
  `cd` in i och kör `claude -p` mot. Claude läser `CLAUDE.md` ur cwd som projektminne automatiskt.
- **Doppelgänger-"skill"** = en **riktig Claude Code-skill** under rollens katalog
  (`agents/planner/.claude/skills/morning-brief/SKILL.md`). Upptäcks av Claudes inbyggda
  skill-mekanism när workern kör `claude -p` i den katalogen. Vi uppfinner inget eget.

> **Katalogregel:** Claude letar `.claude/` i cwd och *uppåt*, aldrig nedåt. Därför läcker
> roll-skills inte in i interaktiv `claude` vid repo-roten. En worker i `agents/planner/`
> ärver dock repo-rotens `.claude/settings.local.json` (behörigheter) — önskat, men inte 100%
> hermetiskt. Vill man ha full isolering körs rollen från en sökväg utanför repot (ej aktuellt nu).

### Housekeeping
`.gitignore`: `node_modules/`, `.env`, ev. lokala `*.local`-filer. Runtime-state ligger i
`$DOPPELGANGER_HOME` utanför repot, så inget sqlite/tokens kan committas av misstag.

---

## Språk
**TypeScript hela vägen** (motor + FE). Skälet är lastbärande: `src/types.ts` (`QueueRow`,
`EventRow`, `Agent`) importeras av både dispatcher/worker och den framtida dashboarden, så
DB-kontraktet aldrig glider isär. `better-sqlite3` (synkront, passar dispatcher-loopen),
`child_process` för `claude -p`.

---

## Datamodell (LÅST — två tabeller)

### `queue` — efemär arbetskö (muteras, rensas)
| fält | typ | syfte |
|---|---|---|
| `id` | PK auto | den efemära kö-radens id |
| `agent` | text | vilken roll som ska köra (= mappnamn under `agents/`) |
| `task` | text | payload, går in i prompten |
| `status` | text | `pending` → `running` |
| `parent` | text, null | `run_id` för körningen som la denna order. `null` = toppnivå (adapter-lagd) |
| `run_id` | text, null | sätts vid `running` (av dispatchern); durabel ULID som körningens events-rader delar |
| `pid` | int, null | workerns process-id, sätts vid `running`, för krasch-städ |
| `running_since` | ts, null | när `running` sattes |
| `attempts` | int | antal startförsök; styr retry-taket vid krasch (default 0) |
| `created_at` | ts | upptäcka stale `pending` (= dispatcher nere = larm) |

### `events` — append-only livscykel-logg (muteras aldrig; bär även anropsträdet)
En körning ger **flera** rader: `started` … (`finished` | `died`). Nuläget är en *projektion* —
folda per `run_id`. `started`-utan-avslut = kör just nu (pulsa). `parent`/`cost`/`summary`/`status`
sitter på avslutsraden.
| fält | typ | syfte |
|---|---|---|
| `id` | PK auto | radens id (en rad per livscykel-event, inte per körning) |
| `run_id` | text | binder ihop en körnings rader (`started` ↔ `finished`/`died`). ULID |
| `kind` | text | `started` / `finished` / `died` |
| `ts` | ts | när detta event inträffade |
| `agent` | text | vem körde (= nod i grafen) |
| `task` | text | vad — *och* payloaden på inkommande kant |
| `parent` | text, null | `run_id` för förälder-körningen (= kant A→B). `null` = toppnivå. (på `finished`) |
| `status` | text, null | på `finished`: `success` / `flagged` / `error` |
| `cost` | real, null | på `finished`: kostnad (ur `total_cost_usd`) |
| `summary` | text, null | på `finished`: agentens egna ord (ur `out.json`) |

**Ingen `messages`-tabell.** En kant A→B *är* en order i kön och blir B:s `finished`-event med
`parent` = A:s run_id. Nodgrafen härleds helt ur `events`: nod = `agent`; kant = `parent`;
kantens payload = mottagarens `task`; tid = `ts`. Live "kör nu"-noder = `started` utan `finished`/`died`.

**Index:** `events(run_id)`, `events(ts)`, `events(agent)`, `events(parent)`; `queue(status)`.
WAL på (flera parallella skrivande workers).

---

## Agent↔worker-kontraktet (LÅST — fil, inte tools)
Agenten skriver en fil i sin körmapp:

```json
{
  "status": "success | flagged | error",
  "summary": "agentens egna ord om vad den gjorde",
  "orders": [ { "agent": "planner", "task": "..." } ]
}
```

Workern läser filen *efter* att `claude -p` avslutat och översätter den till DB-rader. Skäl:
trög, inspekterbar (filen ligger kvar för debug), håller workern dum, och agenten behöver bara
`Write`. (Verktygsbaserad live-emission valdes bort: bryter atomiciteten och kräver att run-id
injiceras in i agenten. Live-uppdatering av dashboarden är inte värt den risken nu.)

### run_id (LÅST)
**Dispatchern** genererar ett **ULID** när den markerar kö-raden `running`, *före* workern
startar. Det skrivs på queue-raden, in i körningens events-rader (`run_id`) och stämplas som
`parent` i alla barn-ordrar. **Agenten ser aldrig sitt eget run_id.** Eftersom A:s `finished`
+ barn-ordrar skrivs i *samma* transaktion vid A:s slut finns A:s avslutsrad alltid när något
pekar på den → inga dinglande referenser. (A:s `started` finns redan dessförinnan.)

---

## Livscykel (LÅST)
1. **Adapter-poll** (driven av in-process `scheduler.ts` på intervall — **ingen OS-cron**) →
   vid nytt arbete: `INSERT queue (agent, task, status=pending, parent=null, created_at=now)`.
2. **Dispatcher** (loop ~5s i samma process som schedulern, blockerar aldrig):
   - **Städa först:** för varje `running`-rad, kolla `pid`-liv (`os.kill(pid,0)` / `/proc/<pid>`).
     Lever → lämna ifred oavsett hur länge. Dött → `INSERT events(kind=died, run_id, agent)`, sedan:
     `attempts < tak` → återställ till `pending` (`attempts++`, nolla `pid`/`run_id`/`running_since`);
     annars → **ge upp** (`DELETE` kö-raden; `died` är redan loggat).
   - **Plocka FIFO atomärt:** generera `run_id` (ULID); `UPDATE queue SET status=running,
     run_id=?, running_since=now WHERE id=? AND status=pending`.
   - **Starta worker:** spawna processen, sätt `pid` på kö-raden, skriv
     `INSERT events(kind=started, run_id, agent, task, parent)`.
3. **Worker:**
   - Kör `claude -p --output-format json` i `agents/<agent>/`, injicerar `task` + relevant registry-kontext.
   - Claude skriver `out.json`.
   - **Vid slut, EN transaktion:** `INSERT events(kind=finished, run_id, status, cost, summary, parent)`
     + en `INSERT` per order (`parent=run_id`) + `DELETE` den egna kö-raden. (`status=error` →
     `finished` med error, inga barn-ordrar.)

### Krasch-återhämtning
**PID-liveness, ingen gissad timeout** (körtid spänner 4 s → 1 h). Städaren överst i
dispatcher-loopen mäter liv direkt. PID-återanvändning hanteras via pid + `running_since`.
En död worker loggas som ett `died`-event (**dispatchern** skriver det — den döda kan inte
rapportera sig själv) och retryas tills `attempts`-taket (default 3), sedan ges upp. Det
stänger en oändlig krasch-loop på en giftig task som tillförlitligt dödar workern.
Heartbeat valt bort: `died` fångar bara process*död*, inte *hängning* (levande pid som frusit) —
hängning är heartbeat-fallet, fortsatt deferred.

### Felhantering (LÅST default)
Två skilda felmoder, båda visualiserbara:
- **`finished`(error)** — `claude` *körde men returnerade fel/skräp* (workern lever). Workern
  skriver `finished` med `status=error`, raderar kö-raden, **ingen retry** (giftig task).
- **`died`** — worker-*processen* försvann. Dispatchern skriver `died` och retryar till taket
  (se Krasch-återhämtning). Larm/finmaskig retry-policy är ett senare, medvetet tillägg.

### Parallellism
Full parallellism: dispatchern spawnar nästa worker oavsett att en 10-min-körning pågår → en
lång CFO-körning blockerar aldrig ett snabbt svar. Latensgolvet för reaktivitet är *adapterns
poll-intervall*, inte agentkörningen. Samtidighetsgränser/klassindelning (interactive/batch)
är bortvalt nu — behövs bara om kostnad/rate-limits blir problem.

---

## Drift & deploy (LÅST — alternativ B)
**En schemaläggningsmekanism, ingen OS-cron.** `src/index.ts` startar både dispatcher-loopen
och `scheduler.ts` (som kör adapter-pollarna på intervall) i **en** Node-process.

- **Prototyp (WSL, nu):** `npm run start` i tmux. Ingen cron, ingen systemd. Skelettet snurrar
  direkt. (WSL kör varken cron eller systemd by default — därför undviker vi båda.)
- **Produktion (senare):** samma process lindas i **en** systemd-unit (`Restart=always`) ur
  `deploy/`-templaten via `install.sh` (idempotent). På Mac → en launchd-plist. Fortfarande
  noll OS-cron.

**Repot = bara kod. State, hemligheter och output bor i `$DOPPELGANGER_HOME`** (default
`~/.local/share/doppelganger/`), utanför repot:
- SQLite-DB, `out.json`, morgon-brief-markdown, Google OAuth-tokens (+ framtida Fortnox-creds).
- Workern kör `claude -p` *i* `agents/<roll>/` (läs-kod) men *skriver* artefakter till
  `$DOPPELGANGER_HOME`. Då är `git pull` alltid säker och repot förblir rent.

**Prerequisites på burken:**
- `claude` CLI installerat och **inloggat** (API-nyckel eller prenumeration) — annars kör ingen worker.
- `gws` CLI installerat och authat (`gws auth login` / `/gws-auth`) — annars når planner inte kalendern.
- Klona hela `nilsark-consulting`-repot (doppelganger är subfolder). Fördel: `entrepreneur`
  återanvänder `nilsark`-pluginen ur samma checkout senare.

---

## Rollen `planner` (skelettets enda agent)
- `agents/planner/CLAUDE.md`: identitet + **kalenderkarta**. Kartan är nyckelkonfigurationen:
  vilka kalender-ID som finns och vad var och en är till för; default-mål per händelsetyp
  ("AW" → familj; "kundmöte" → företag); krock-koll läser BÅDA kalendrarna.
  - **Företag/jobb:** `richard@nilsark.com`
  - **Privat/familj:** `richard.nilsark@gmail.com`
  - (Dessa är de två primära kalendrarna. Finns ytterligare del-kalendrar under något konto
    mappas de in i kartan senare — primärerna räcker för skelettet.)
- `agents/planner/.claude/skills/morning-brief/SKILL.md`: läser företags- OCH familjekalendern
  (`gws calendar events list` per kalender, eller `gws calendar +agenda`), kör krock-koll med
  `gws calendar freebusy` över båda, skriver briefen till en markdown-fil i `$DOPPELGANGER_HOME`
  och en `out.json` med `status` + `summary`.
- **Kalenderåtkomst: `gws`-CLI:t via `Bash`** (`gws calendar events`/`freebusy`/`+agenda`),
  samma headless-mönster som CFO använder för `gws gmail`/`gws drive`. Ingen hostad MCP-connector
  — `gws auth login` authar en gång på burken (jfr `/gws-auth`). Verifierat: gws 0.22.3 har full
  `calendar`-service. Detta är vad som gör planner körbar self-hosted.
- **Två-konto-haken:** gws är authad som `richard@nilsark.com` (jobb). Familjekalendern
  `richard.nilsark@gmail.com` är ett *annat konto* → läses bara om den är **delad in i**
  jobbkontot (läsrätt) ELLER via en andra gws-auth. Måste lösas innan briefen blir korrekt
  (se Öppna förberedelser). Rör inte arkitekturen — ren setup.
- **Isolering (ärlig not):** doktrinen "planner rör ALDRIG Gmail/Fortnox" är i skelettet
  **instruktions-tvingad, inte förmåge-tvingad** — eftersom `gws` är inloggat med full
  Workspace-scope skulle planner *tekniskt* kunna anropa `gws gmail`. Det är konsekvent med
  CFO:s befintliga `instruction-gated`-modell. **Hårdning (deferred):** egen calendar-scoped
  credential för planner så isoleringen blir kapabilitets-tvingad. Relevant först när planner
  tar emot otrodd input (WhatsApp) — inte i skelettet.

### Prerequisite (tidigt sidosteg)
Ta fram Google-kalender-ID:na och mappa vilka som är företag resp. familj → in i
kalenderkartan. Google-kalendrarna är flera och delvis överlappande; kräver uppstädning innan
planner litar på dem.

---

## registry.yaml
Sanningskälla för vilka agenter som finns och `can_be_called_by` (säkerhetsgränsen).
Dispatchern validerar kö-rader mot den; relevanta delar injiceras i agentens prompt (ingen
dubbellagring i varje `CLAUDE.md`). I skelettet: bara `planner`, anropbar av `schedule`.

---

## Definition of Done
Kör dispatchern och se:
1. `schedule`-adaptern lägger `agent=planner, task=morning_brief` i kön vid tidpunkt.
2. Dispatchern plockar den atomärt, startar en worker.
3. Workern kör `claude -p` i `agents/planner/`, morgon-briefen produceras som markdown-fil
   **med krock-koll över båda kalendrarna**.
4. Två `events`-rader dyker upp för körningen: `started`, sedan `finished`
   (`agent=planner`, `status=success`, `summary` ifylld, `parent=null`).
5. Kö-raden är borttagen.

Hela kedjan verifierad → allt annat blir additivt.

---

## Testning
- **Enhets-/integrationsnära:** kan inserta/läsa rader i `queue` + `events`; typerna i
  `types.ts` delas och kompilerar mot DB-kontraktet.
- **Atomärt plock:** två dispatcher-pass mot samma `pending`-rad ger exakt en `running` + ett `started`.
- **Krasch-städ:** en `running`-rad med död `pid` → ett `died`-event + återställd till `pending` (`attempts++`).
- **Retry-tak:** en rad som dör `tak` gånger ger ett sista `died` och tas bort, ingen ny retry.
- **Felväg:** en roll som returnerar `status=error` ger ett `finished`(error) + borttagen kö-rad, ingen retry.
- **End-to-end:** DoD ovan, körd skarpt med en riktig (men billig) `claude -p`-körning.

---

## Medvetet bortvalt nu (lägg till vid behov, additivt)
- **Dashboard / visualisering** (D3-nodgraf, SSE, Recharts) → byggs *efter* att backenden
  spottar äkta `events`. Att designa viz mot fejkdata är en känd fälla. **FE-riktning (förlovad):**
  wow först (levande konstellation: fasta registry-noder som lyser upp, prickar längs kanter,
  pulsande `started`-noder), inspektion som debug-panel. **v1 läser bara `events`** i ett fönster,
  foldar per `run_id`; ensam `started` = pulsa (gissa aldrig "stale" via timeout). Zombie (ensam
  `started` när dispatchern själv var nere) får åldras ut ur fönstret. `queue`-som-auktoritativ-
  live-källa + lång-körning-bortom-fönster är en senare uppgradering om det behövs.
- **`entrepreneur`/CFO-roll** → återanvänder den befintliga `nilsark`-pluginen headless under
  `claude -p` (kopiera inte). Rör inte nuvarande interaktiva `/cfo-run`.
- **Triage-grind** (Haiku/Ollama "ja/nej" framför dumma adaptrar) → kostnadsoptimering, senare.
- **WhatsApp/iMessage-adapter + dubbelriktad chatt mot planner** → efter kalender funkar.
- **Heartbeat** → bara om workers hänger sig levande.
- **Klassindelning interactive/batch + samtidighetsgränser** → om kostnad/rate-limits biter.
- **Gmail Pub/Sub-push** → om sekund-snabb mailreaktion nånsin behövs (poll räcker).
- **Kapabilitets-tvingad roll-isolering** (calendar-scoped credential för planner istället för
  delad `gws`-auth) → när planner tar emot otrodd input (WhatsApp). Skelettet kör instruktions-nivå.
- **Alltid-på hårdvara** (Mac mini / Linux-burk) → beslut *efter* att skelettet snurrar på WSL.

---

## Öppna förberedelser innan implementation
1. ~~Verifiera `claude -p --output-format json` ger `cost`~~ — **klart ✅** (`total_cost_usd` +
   `usage` finns; kallstart ~$0.018/13.8k cache-tokens i WSL). Worker läser `total_cost_usd`.
2. ~~Ta fram Google-kalender-ID:na~~ — **klart:** `richard@nilsark.com` (jobb),
   `richard.nilsark@gmail.com` (familj).
3. ~~Verifiera gws-calendar~~ — **klart ✅** (gws 0.22.3, full `calendar`-service:
   `events`/`freebusy`/`+agenda`). Auth funkar som `richard@nilsark.com`.
4. ~~Familjekalendern åtkomlig från jobbkontot~~ — **klart ✅** `richard.nilsark@gmail.com`s
   kalender är delad med `richard@nilsark.com` ("Göra ändringar i händelser") → båda läses med
   en enda gws-auth.
5. **Deploy-not:** gws använder keyring-backend. På en GUI-lös always-on-burk kan keyring kräva
   konfig (eller fil-backend). Funkar i WSL nu; verifiera på prod-burken senare.
