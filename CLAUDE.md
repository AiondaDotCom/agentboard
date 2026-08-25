# Agentboard

Lightweight realtime Kanban board for AI agents. GitHub: AiondaDotCom/agentboard

## Architecture

```
HTTP Server (src/server.ts, port 3000)
├── /api/*    REST Routes  ──┐
├── /mcp      MCP Server   ──┤──▶  BoardService  ──▶  AgentboardDB  ──▶  SQLite
├── /graphql  WebSocket    ──┘     (src/services/)     (src/db/)
└── PubSub (in-memory, geteilt fuer Echtzeit)
```

- **Ein Prozess**: REST, MCP und WebSocket laufen im selben Node-Prozess. MCP-Aenderungen triggern sofort WebSocket-Events.
- **Single business layer**: `BoardService` ist der einzige Zugang zur DB fuer Business-Operationen. REST und MCP rufen beide den Service auf – nie direkt die DB. **ALL business logic MUST live in BoardService.** REST routes and MCP tools are thin adapters only – they handle I/O (HTTP, JSON-RPC) and delegate to the service. Never put business logic (validation, PubSub events, activity logging) in routes or MCP tool handlers.
- **DB Layer** (`AgentboardDB`): Reiner Datenzugriff, Row-Mapping, keine Business-Logik.
- **Audit Middleware**: HTTP-Request-Logging (REST + MCP) als Infrastruktur direkt am DB-Layer.
- **PubSub**: Global Singleton (`src/graphql/pubsub.ts`), vom Service genutzt fuer WebSocket-Events.

## Tech Stack

- TypeScript, Express, better-sqlite3, Apollo Server, graphql-ws
- Frontend: Vanilla JS, Glassmorphism UI, FLIP-Animationen
- MCP: `@modelcontextprotocol/sdk` (StreamableHTTP transport, eingebettet im Server)
- Tests: Vitest (185+ unit tests)

## Wichtige Konventionen

- Admin API Key ist persistent in SQLite (settings table), nicht hardcoded
- `npm run build` kopiert auch schema.sql nach dist/ (`tsc && cp src/db/schema.sql dist/db/schema.sql`)
- Demo-Script ist TypeScript (`demo.ts`), nicht Bash (macOS Bash 3.2 Probleme)
- Demo liest Admin-Key direkt aus SQLite
- Frontend nutzt GraphQL WebSocket Subscriptions – kein Polling fuer Echtzeit
- **Live Runtime Status**: `POST /api/runtime` nimmt mit einem dedizierten `X-Api-Key` Heartbeats von Host-Collectors an. Der Header zeigt wirklich laufende Codex-/Claude-Turns gruen, offene idle Prozesse nicht als arbeitend, plus die persistente Non-stop-Dauer im gewuenschten Format `3 AIs working since 3 days and 6 hours`; nach 130 Sekunden ohne Heartbeat wird der Host als offline behandelt. Statuswechsel kommen per GraphQL-Subscription, ein 15s-Poll stellt TTL-/Reconnect-Updates sicher und ein lokaler 1s-Timer aktualisiert die Sekunden ohne API-Last. Der macOS-Collector unter `scripts/` scannt alle 10s, sendet bei Aenderung bzw. alle 60s und laeuft per LaunchAgent beim Login.
- Kommentare: neueste oben (reversed)
- Ticket-Revisions sind revisionssicher (tamper-proof audit trail)
- **Ticket-Gruppen**: Tickets koennen per `group` gebuendelt werden (optional bei create/update). Claim-Regel im BoardService: Weist sich ein Agent ein Ticket einer Gruppe zu, gehoert ihm die ganze Gruppe – andere Agents bekommen `ConflictError` (HTTP 409). Der Claim ist aus `assignee_id` abgeleitet (kein Lock): Unassign oder alle Tickets in der letzten Spalte geben die Gruppe frei. Frontend clustert Gruppen pro Spalte mit Farbcodierung (Hue aus Gruppenname) und Claim-Badge.
- **Konfigurierbare Spalten pro Projekt**: `projects.columns` (JSON `[{id, title}]`). Konvention: ERSTE Spalte = Inbox fuer neue Tickets (auch Reopen-Ziel), LETZTE Spalte = fertig (Done-Semantik fuer Gruppen-Claim und Dependencies). Default fuer neue Projekte: backlog, blocked, in_progress, rework, in_review, done. Bestehende Projekte wurden per Migration auf das alte 5er-Set (mit `ready`) eingefroren. Spalten mit Tickets koennen nicht entfernt werden (erst Tickets verschieben). Aenderung via `update_project` (MCP), `PATCH /api/projects/:id` (admin) oder `PUT /api/projects/:id/columns` (Human/UI, Spalten-Editor ueber ⚙️-Button).
- **blocked_reason**: Freitextfeld am Ticket (warum es extern blockiert ist), prominent auf Karte + Modal, revisionssicher geloggt. Leerer String loescht es.
- **priority**: Ticket-Prioritaet `low | medium | high | critical` (Default `medium`, Konstanten in `types.ts`). Validierung im BoardService, revisionssicher geloggt. Frontend: farbiges Badge auf Karte + Modal; Tickets werden innerhalb einer Spalte nach Prioritaet sortiert (hoechste oben), Position als Tiebreaker.
- **work_type**: Art der Arbeit am Ticket – `mechanical` (Bauform steht fest, Diff gegen hartes Fertig-Kriterium pruefbar) oder `judgment` (Entwurf, Ursachensuche, Abwaegung). Nullable, kein Default: unklassifiziert ist ein eigener Zustand, leerer String loescht die Einordnung. Bewusst KEINE Modellnamen im Ticket – die Zuordnung Art → Modell gehoert an eine Stelle, Modellnamen veralten. Filter in `list_tickets` (MCP), `POST /api/batch` und `GET /api/projects/:id/tickets?work_type=` mit den Werten `mechanical | judgment | none` (`none` = unklassifiziert), damit ein billiger Agent gezielt nur mechanische Tickets ziehen kann. Revisionssicher geloggt, Badge auf Karte + Modal (keins wenn unklassifiziert). Konstanten `WORK_TYPES` / `WORK_TYPE_FILTERS` in types.ts.
- **depends_on**: Array von Ticket-IDs am Ticket. Regel: Solange eine Dependency nicht in der LETZTEN Spalte ist, darf das Ticket nur in der ERSTEN Spalte liegen – jede andere Bewegung wirft `ConflictError` (409) mit Begruendung, welche Tickets in welcher Spalte noch offen sind. Zyklen werden beim Setzen abgelehnt. Frontend: Dep-Badge auf der Karte (rot = offen, gruen = alle fertig), Klick zeichnet SVG-Pfeile zu den Dependency-Karten; Modal listet Dependencies mit Status. Tabelle `ticket_dependencies` (CASCADE bei Ticket-Loeschung).
- **Ticket-Modal (Jira-Layout)**: Sticky Header (Ticket-ID + Close), darunter EIN Scroll-Container (`.modal-body`) mit zwei Spalten: links Titel/Beschreibung/Deps/Tabs (Comments, History), rechts sticky Details-Panel (Status, Priority, Work type, Assignee, Author, Group, Updated). Die Beschreibung hat KEINE eigene Scrollbox mehr – das ganze Ticket scrollt am Stueck. Leere Detail-Zeilen werden ausgeblendet (`setSideValue`/`toggleSideRow` in app.js); Assignee zeigt „Unassigned". Unter 900px klappt die Sidebar ueber den Content.
- **Zuletzt angefasst**: `updated_at` wird auf jeder Karte (🕒) und im Modal angezeigt.
- **Batch-Operationen**: MCP-Tool `batch` und `POST /api/batch` fuehren bis zu 100 Operationen sequenziell in EINEM Aufruf aus. Jeder Eintrag ist `{op, args}` mit exakt denselben Namen/Argumenten wie die Einzel-Tools (16 Ops, alle ausser whoami; Konstante `BATCH_OPS` in types.ts). Per-Item-Ergebnis `{op, ok, result|error}` – Fehler stoppen die anderen Ops NICHT (kein Rollback), eine BATCH-Zeile im Audit-Log fasst zusammen. Dispatcher: `BoardService.executeBatch()`. Der MCP-Server wirbt aktiv fuer batch (Server-`instructions` beim Connect via `MCP_INSTRUCTIONS`, batch-Tool-Description, Hinweise in create/update/move_ticket), damit KI-Clients bei >1 Operation immer batch statt Einzelaufrufen nutzen (1 Roundtrip statt N).
- **Testabdeckung**: 100% (statements/branches/functions/lines) fuer alle `src/`-Module ausser `server.ts` (Bootstrap, via Playwright-E2E abgedeckt). Thresholds in vitest.config.ts stehen auf 100 – neue Features brauchen vollstaendige Tests.

## Scripts

- `./run.sh` – Server starten (build + start)
- `./stop_server.sh` – Server stoppen
- `./demo.sh` – Demo-Modus (startet Server automatisch falls noetig)
- `npx vitest run` – Alle Tests ausfuehren

## MCP Server

Eingebettet im HTTP-Server (gleicher Prozess, gleicher PubSub). Claude Code Anbindung:
```
claude mcp add -t http -s user agentboard http://localhost:3000/mcp
```
Server muss laufen (`./run.sh`) damit MCP erreichbar ist.

18 Tools: batch, list_projects, create_project, get_project, update_project, delete_project, list_tickets, get_ticket, create_ticket, update_ticket, move_ticket, assign_ticket, delete_ticket, add_comment, get_comments, get_ticket_history, list_agents, whoami
