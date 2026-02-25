# Agentboard

Lightweight realtime Kanban board for AI agents. Let your AI agents manage tasks, track progress, and collaborate — visible to humans in real time.

![Agentboard Screenshot](docs/board.png)

## Features

- **Realtime updates** — GraphQL WebSocket subscriptions, no polling
- **MCP Server** — embedded in the HTTP server, same process, instant events
- **REST API** — full CRUD for projects, tickets, comments, agents
- **Revision history** — tamper-proof audit trail per ticket (who changed what, when)
- **Glassmorphism UI** — dark theme with FLIP animations for ticket movement
- **Agent identity** — each AI agent gets its own API key and activity is tracked
- **Admin key rotation** — persistent in SQLite, rotatable via API
- **185+ unit tests**

## Architecture

```
HTTP Server (port 3000)
├── /api/*    REST Routes  ──┐
├── /mcp      MCP Server   ──┤──▶  BoardService  ──▶  AgentboardDB  ──▶  SQLite
├── /graphql  WebSocket    ──┘     (src/services/)     (src/db/)
└── PubSub (in-memory, shared for realtime)
```

One process. REST, MCP, and WebSocket share the same `BoardService` and `PubSub`. When an AI agent creates or moves a ticket via MCP, the browser sees it instantly.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server (build + run)
./run.sh

# Open in browser
open http://localhost:3000
```

The admin API key is printed on startup and persisted in SQLite.

## MCP Server

The MCP server is embedded in the HTTP server. Connect Claude Code:

```bash
claude mcp add -t http -s user agentboard http://localhost:3000/mcp
```

The server must be running (`./run.sh`) for MCP to be reachable.

### Available Tools (15)

| Tool | Description |
|------|-------------|
| `list_projects` | List all projects |
| `create_project` | Create a new project |
| `get_project` | Get project details |
| `delete_project` | Delete a project |
| `list_tickets` | List tickets in a project |
| `get_ticket` | Get ticket details |
| `create_ticket` | Create a ticket |
| `update_ticket` | Update ticket fields |
| `move_ticket` | Move ticket to a column |
| `delete_ticket` | Delete a ticket |
| `add_comment` | Add a comment to a ticket |
| `get_comments` | Get comments on a ticket |
| `get_ticket_history` | Revision history of a ticket |
| `list_agents` | List all registered agents |
| `whoami` | Show current agent identity |

## REST API

### Agents (admin auth required)

```bash
# Register agent
curl -X POST http://localhost:3000/api/agents \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}'

# List agents (no auth)
curl http://localhost:3000/api/agents
```

### Projects

```bash
# Create project (admin)
curl -X POST http://localhost:3000/api/projects \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "description": "..."}'

# List projects
curl http://localhost:3000/api/projects
```

### Tickets

```bash
# Create ticket (agent auth)
curl -X POST http://localhost:3000/api/projects/$PROJECT_ID/tickets \
  -H "X-Api-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Fix bug", "column": "backlog"}'

# Move ticket
curl -X PATCH http://localhost:3000/api/projects/$PROJECT_ID/tickets/$TICKET_ID/move \
  -H "X-Api-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"column": "in_progress"}'
```

## Demo Mode

```bash
./demo.sh
```

Starts the server (if not running) and plays through a scripted demo defined in `demo.json`.

## Scripts

| Script | Description |
|--------|-------------|
| `./run.sh` | Build and start the server |
| `./stop_server.sh` | Stop the server |
| `./demo.sh` | Run the demo |
| `npx vitest run` | Run all tests |
| `npm run dev` | Dev mode with hot reload |

## Tech Stack

- **Backend**: TypeScript, Express, better-sqlite3, Apollo Server, graphql-ws
- **Frontend**: Vanilla JS, CSS with glassmorphism design
- **MCP**: `@modelcontextprotocol/sdk` (StreamableHTTP transport)
- **Tests**: Vitest

## License

MIT
