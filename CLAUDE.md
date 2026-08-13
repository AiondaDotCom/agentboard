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
- Kommentare: neueste oben (reversed)
- Ticket-Revisions sind revisionssicher (tamper-proof audit trail)
- **Ticket-Gruppen**: Tickets koennen per `group` gebuendelt werden (optional bei create/update). Claim-Regel im BoardService: Weist sich ein Agent ein Ticket einer Gruppe zu, gehoert ihm die ganze Gruppe – andere Agents bekommen `ConflictError` (HTTP 409). Der Claim ist aus `assignee_id` abgeleitet (kein Lock): Unassign oder alle Tickets in der letzten Spalte geben die Gruppe frei. Frontend clustert Gruppen pro Spalte mit Farbcodierung (Hue aus Gruppenname) und Claim-Badge.
- **Konfigurierbare Spalten pro Projekt**: `projects.columns` (JSON `[{id, title}]`). Konvention: ERSTE Spalte = Inbox fuer neue Tickets (auch Reopen-Ziel), LETZTE Spalte = fertig (Done-Semantik fuer Gruppen-Claim und Dependencies). Default fuer neue Projekte: backlog, blocked, in_progress, rework, in_review, done. Bestehende Projekte wurden per Migration auf das alte 5er-Set (mit `ready`) eingefroren. Spalten mit Tickets koennen nicht entfernt werden (erst Tickets verschieben). Aenderung via `update_project` (MCP), `PATCH /api/projects/:id` (admin) oder `PUT /api/projects/:id/columns` (Human/UI, Spalten-Editor ueber ⚙️-Button).
- **blocked_reason**: Freitextfeld am Ticket (warum es extern blockiert ist), prominent auf Karte + Modal, revisionssicher geloggt. Leerer String loescht es.
- **priority**: Ticket-Prioritaet `low | medium | high | critical` (Default `medium`, Konstanten in `types.ts`). Validierung im BoardService, revisionssicher geloggt. Frontend: farbiges Badge auf Karte + Modal; Tickets werden innerhalb einer Spalte nach Prioritaet sortiert (hoechste oben), Position als Tiebreaker.
- **depends_on**: Array von Ticket-IDs am Ticket. Regel: Solange eine Dependency nicht in der LETZTEN Spalte ist, darf das Ticket nur in der ERSTEN Spalte liegen – jede andere Bewegung wirft `ConflictError` (409) mit Begruendung, welche Tickets in welcher Spalte noch offen sind. Zyklen werden beim Setzen abgelehnt. Frontend: Dep-Badge auf der Karte (rot = offen, gruen = alle fertig), Klick zeichnet SVG-Pfeile zu den Dependency-Karten; Modal listet Dependencies mit Status. Tabelle `ticket_dependencies` (CASCADE bei Ticket-Loeschung).
- **Zuletzt angefasst**: `updated_at` wird auf jeder Karte (🕒) und im Modal angezeigt.
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

17 Tools: list_projects, create_project, get_project, update_project, delete_project, list_tickets, get_ticket, create_ticket, update_ticket, move_ticket, assign_ticket, delete_ticket, add_comment, get_comments, get_ticket_history, list_agents, whoami
