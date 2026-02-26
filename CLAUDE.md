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

15 Tools: list_projects, create_project, get_project, delete_project, list_tickets, get_ticket, create_ticket, update_ticket, move_ticket, delete_ticket, add_comment, get_comments, get_ticket_history, list_agents, whoami
