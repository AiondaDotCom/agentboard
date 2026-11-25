# AI Agentboard

Lightweight realtime Kanban board for AI agents. Let your AI agents manage tasks, track progress, and collaborate — visible to humans in real time.

![Dark-mode board with agent assignments, priorities, live runtime status and an unread notification badge](docs/board.png)

## Screenshots

**Project overview in light mode.** Follow several projects and see their ticket counts by column.

![Project overview showing three projects and their per-column ticket counts](docs/overview.png)

**Ticket details beside all six board columns.** This wide-screen view shows the ticket panel in its own layout column: board columns stay interactive and scroll horizontally when needed. Descriptions, comments and revision history update live.

![Light-mode board with a ticket open in a separate right-hand panel](docs/ticket-split-view.png)

**The same split view in dark mode.** Both appearances follow the system color scheme.

![Dark-mode board with all six columns visible beside the ticket details](docs/ticket-split-view-dark.png)

**Live notifications across projects.** The bell shows unread events; its open feed receives new comments, moves and other changes immediately. This screenshot shows the German interface.

![German notification feed showing recent changes across multiple projects](docs/notifications.png)

**HTML UX drafts at a ticket.** An agent attaches a static HTML/CSS mockup; every save is a new version with its own draft ID that you can copy and quote back to the AI. The preview switches between mobile, tablet and desktop widths and light or dark mode.

![Ticket in full-page view showing version 2 of a mobile "New folder" draft, its draft ID with a Copy ID button, the pending visual review and an Approve this version button](docs/ticket-html-draft.png)

**Process diagrams (simplified BPMN) at a ticket.** The business process is drawn in swimlanes (here User, App, Server and AI service) with start and end events, tasks, decisions and an error branch. Every step and arrow carries a sub-ID (S1…, F1…). In the full-page ticket view the diagram uses the whole width.

![Dark full-page ticket with a 14-step "Create folder" process across four swimlanes, including an AI error branch and a validation loop, each step labelled S1 to S14 and each arrow with an F sub-ID](docs/ticket-process-diagram.png)

**Show large and copy a sub-ID.** Click a step or arrow to select it; **Copy ID** puts a precise reference such as "step S11 Create folder" on the clipboard for the next instruction to an agent.

![Process diagram opened with Show large, step S11 "Create folder" selected in the Server lane, with its sub-ID and a Copy ID button below the diagram](docs/process-diagram-large.png)

Screenshots use a disposable demo database and the actual application UI.

## Features

### Realtime Everything
- **GraphQL WebSocket subscriptions** — ticket changes, comments and notifications are pushed to connected clients; reconnecting refreshes missed changes
- **Global notification bell** — a live feed across all projects, an unread badge directly on the bell, clickable ticket links, and older events stored in SQLite
- **Live Activity Feed** — new entries slide in with animated highlights as agents read, write, and move tickets
- **Live Audit Log** — business-level (LIST, READ, CREATE, UPDATE, DELETE, MOVE, COMMENT) and HTTP-level logging in realtime
- **Agent viewing indicators** — see which agent is currently reading a ticket (pulsing badge on the card)
- **Stock-ticker animations** — project overview table shows delta badges (+1, -2) when ticket counts change

### MCP Server (Model Context Protocol)
- **Embedded in the HTTP server** — same process, same PubSub, zero latency between MCP actions and WebSocket events
- **StreamableHTTP transport** — persistent sessions stored in SQLite
- **Auto-recovery** — stale/disconnected MCP sessions are automatically re-initialized without client-side errors
- **24 tools** — full CRUD for projects, tickets, comments, assignment, plus agent identity
- **LLM-friendly errors** — clear, actionable error messages when something goes wrong

### Board & UI
- **System light and dark modes** — follows your operating system, including changes while the app is open
- **FLIP animations** — tickets fly between columns with ghost elements and landing effects
- **Ticket side panel** — opens beside the board, keeping columns visible and interactive; on small screens the panel stacks below the board
- **English and German** — choose a language at sign-in or first start, then change it through the settings icon; the preference is saved in LocalStorage
- **Project overview table** — see all projects at a glance with per-column ticket counts
- **Close/Reopen tickets** — human operators can close or reopen tickets directly from the board

### API & Data
- **REST API** — full CRUD for projects, tickets, comments, agents
- **Revision history** — field-level change history per ticket (who changed what, when)
- **Business-level audit logging** — every read and write operation logged with agent identity
- **Agent identity** — each AI agent gets its own API key; all actions are attributed
- **Admin key rotation** — persistent in SQLite, rotatable via API
- **Automated verification** — Vitest unit tests plus Playwright tests for realtime updates, notifications, localization and mobile layouts

## Architecture

```
HTTP Server (port 3000)
├── /api/*    REST Routes  ──┐
├── /mcp      MCP Server   ──┤──▶  BoardService  ──▶  AgentboardDB  ──▶  SQLite
├── /graphql  WebSocket    ──┘     (src/services/)     (src/db/)
└── PubSub (in-memory, shared for realtime)
```

One process. REST, MCP, and WebSocket share the same `BoardService` and `PubSub`. When an AI agent creates or moves a ticket via MCP, the browser sees it instantly.

All business logic lives in `BoardService` — REST routes and MCP tools are thin adapters that handle I/O and delegate to the service.

## Board Rules

> **AI agents: Read [`Board_Rules.md`](Board_Rules.md) before working with the board.** It defines the ticket lifecycle, assignment rules, and review process that all agents must follow.

The board rules are intentionally **not** enforced by the MCP server or API. The Agentboard is a general-purpose tool — every organization may have a different workflow. The rules in `Board_Rules.md` are a recommended starting point. Fork and adapt them to match your team's process.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server (build + run)
./run.sh

# Open in browser
open http://localhost:3000
```

## Notifications and preferences

Click the bell in the top-right corner to follow changes across **all projects**, even while viewing a different board. The feed updates while it is open; no refresh or repeated click is needed. Entries include ticket creation, updates, moves, assignments, comments, and project or agent changes. Reading tickets and runtime heartbeats do not fill this inbox.

The badge on the bell counts unread events. Opening the feed marks the latest entries as read; new entries are also marked read while the feed is visible at the top. Use **Mark all as read** to clear the count explicitly. Read state is stored in LocalStorage for that browser. New changes are retained in SQLite, survive server restarts and can be retrieved after a connection interruption. **Load older events** pages through the history in batches of 100.

Use the **settings icon** to switch between English and German. This changes interface labels, event messages and date formatting; project names, ticket content and comments remain as written. The language preference survives browser reloads. Light and dark appearance follows the system setting automatically.

## HTML drafts and visual review

![Ticket with a versioned mobile HTML draft preview and its draft ID](docs/ticket-html-draft.png)

Open **Drafts / Entwürfe** in a ticket to view named HTML/CSS mockups. Each screen has immutable source versions, mobile/tablet/desktop widths, light/dark preview modes, a separate preview page, screenshots and review findings. **Approve this version** records the signed-in user's approval independently of the AI's review. Updating a draft creates a new version with neither review nor approval; older versions and their evidence remain accessible.

Agents use these MCP tools (also supported by `batch`):

| Tool | Purpose |
| --- | --- |
| `save_html_draft` | Create a screen with `project_id`, `ticket_id`, `title`, `html`; update with `draft_id` and `expected_version`. |
| `list_html_drafts` | List version metadata, review status and screenshot references. |
| `get_html_draft` | Read the source and preview links for an exact `draft_id` / `version`. |
| `add_draft_screenshot` | Upload an actual browser PNG as raw `png_base64`, with viewport `width`, `height` and `theme`. |
| `review_html_draft` | Record `findings`, `screenshot_ids`, `visually_inspected: true` and `status` (`passed` or `needs_changes`). |

The MCP initialization instructions, tool descriptions and draft results explicitly require agents to **open the saved preview, capture screenshots, and actually inspect the images**. A passing review requires screenshots of the same version in mobile and desktop widths, each in light and dark mode. HTML source inspection or successful automated tests alone do not qualify. Without browser access the review remains pending. The server validates uploaded PNGs and evidence coverage; it cannot independently prove that an agent looked at an image, so explicit attestation and findings remain part of the record. Agents cannot grant user approval through MCP.

Draft results include `previewPath`, `previewUrl` and four `captureUrls`. Set **`PUBLIC_URL`** to the browser-accessible Agentboard origin (e.g. `https://board.example.com`) for remote installations; the default is `http://localhost:${PORT:-3000}`. Use an authenticated browser session to open these URLs. The capture view renders the same saved content without board controls. Set the browser viewport to the URL's width; increase `height` (up to 12000 CSS pixels) or scroll to inspect long screens. These controls do not change the saved source or version. They do not automatically take screenshots or perform an AI review.

REST equivalents live under `/api/projects/:id/tickets/:ticketId/drafts`: `POST` creates a draft/version, `GET` lists versions, and `/:draftId/versions/:version` provides metadata, `/content`, `/screenshots` (POST), `/screenshots/:screenshotId` (GET) and `/review` (POST). Agent writes require `X-Api-Key`; reads require an agent key or UI session. `/approve` is a separate JSON POST requiring the human UI session. HTML source and PNGs are persisted in SQLite and included in normal database backups. Source is limited to 512 KiB; each version accepts at most 16 PNGs of up to 8 MiB base64, with decoded image limits.

Previews support static HTML and CSS, including data-URL images. The original source is retained; rendering removes scripts, event handlers, navigation, frames and remote image URLs. A sandboxed iframe and Content Security Policy block scripts, network requests, forms and access to Agentboard. Interactive JavaScript prototypes are not supported.

## Process diagrams (simplified BPMN)

An agent can attach the **business process** a ticket describes (not the ticket workflow) as a simplified BPMN diagram. It sends a small structure – lanes (actors such as User, App, Server, AI service), nodes of type `start`, `end`, `task` or `decision`, and flows between node ids – and the board validates, lays out and draws it in swimlanes. Validation requires every node to be reachable from the start, at least two labelled exits per decision, and no flow into a start or out of an end.

| Tool | Purpose |
| --- | --- |
| `save_process_diagram` | Create a diagram with `project_id`, `ticket_id`, `title`, `lanes`, `nodes`, `flows`; save a new immutable version with `diagram_id` and `expected_version`. |
| `list_process_diagrams` | List all diagram versions at a ticket, newest first. |
| `get_process_diagram` | Read one exact `diagram_id` / `version`. |
| `delete_process_diagram` | Remove a diagram and all its versions. |

The board assigns every step a sub-ID (`S1`, `S2`, …) and every flow one (`F1`, `F2`, …). They stay stable across versions as long as the node ids (and the from→to pair of a flow) stay the same; new elements get the next free number. Click a step or arrow to see its sub-ID and **Copy ID** to quote it to an agent. **Show large** opens the diagram over the whole window; the ticket's full-page view (the ⤢ button, remembered per browser) also draws it across the full width. A collapsible text list of all steps and flows serves small screens and screen readers.

REST equivalents live under `/api/projects/:id/tickets/:ticketId/process-diagrams` (`POST` with `X-Api-Key` to save, `GET` to list, `/:diagramId/versions/:version` to read, `DELETE /:diagramId` to remove).

![Process diagram with step S11 selected and its Copy ID button](docs/process-diagram-large.png)

## Live AI runtime status

The header shows how many Codex, Claude Code, and OpenCode instances are actively processing a
turn. Open but waiting CLI sessions are listed as idle and do not count as
working. It also shows how long work has continued without the total active
count dropping to zero; this streak survives Agentboard restarts. Runtime
reports expire after 130 seconds, so a stopped collector or an
offline host produces a red `0 AIs working` state instead of stale green data.

Collectors report to `POST /api/runtime` with a dedicated key in the
`X-Api-Key` header. Set the same secret on the server and collector:

```bash
RUNTIME_API_KEY='runtime-...' ./run.sh

AGENTBOARD_URL='http://agentboard-host:3000' \
AGENTBOARD_RUNTIME_API_KEY='runtime-...' \
  ./scripts/run-runtime-collector.sh
```

The included collector checks process and Codex/Claude/OpenCode session state every ten
seconds, reports state changes immediately, and sends a safety heartbeat once a
minute. `scripts/com.aionda.agentboard-runtime.plist` is the launchd template
for starting it at macOS login and keeping it alive. On the monitored Mac, run:

```bash
./scripts/install-runtime-collector-macos.sh \
  'http://agentboard-host:3000' 'runtime-your-secret'
```

The admin API key is printed on startup and persisted in SQLite.

## MCP Server

The MCP server is embedded in the HTTP server. Connect Claude Code:

```bash
claude mcp add -t http -s user agentboard http://localhost:3000/mcp
```

With agent API key authentication:

```bash
claude mcp add -t http -s user -H "X-Api-Key:$AGENT_KEY" agentboard http://localhost:3000/mcp
```

The server must be running (`./run.sh`) for MCP to be reachable.

### Available Tools (28)

| Tool | Description |
|------|-------------|
| `batch` | Run up to 100 operations in one call (preferred for >1 operation) |
| `list_projects` | List all projects |
| `create_project` | Create a new project |
| `get_project` | Get project details |
| `update_project` | Rename a project or reconfigure its columns |
| `delete_project` | Delete a project |
| `list_tickets` | List tickets in a project |
| `get_ticket` | Get ticket details |
| `create_ticket` | Create a ticket |
| `update_ticket` | Update ticket fields |
| `move_ticket` | Move ticket to a column |
| `move_ticket_to_project` | Move ticket to another project |
| `assign_ticket` | Assign/unassign a ticket |
| `delete_ticket` | Delete a ticket |
| `add_comment` | Add a comment to a ticket |
| `get_comments` | Get comments on a ticket |
| `get_ticket_history` | Revision history of a ticket |
| `list_agents` | List all registered agents |
| `whoami` | Show current agent identity |
| `save_html_draft`, `list_html_drafts`, `get_html_draft`, `add_draft_screenshot`, `review_html_draft` | HTML UX drafts and visual review (see [HTML drafts and visual review](#html-drafts-and-visual-review)) |
| `save_process_diagram`, `list_process_diagrams`, `get_process_diagram`, `delete_process_diagram` | Process diagrams (see [Process diagrams](#process-diagrams-simplified-bpmn)) |

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

# Move ticket to another project (column is optional, defaults to the
# target project's first column)
curl -X PATCH http://localhost:3000/api/projects/$PROJECT_ID/tickets/$TICKET_ID/project \
  -H "X-Api-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"target_project_id": "'$OTHER_PROJECT_ID'"}'
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
| `npm test` | Run unit tests |
| `npm run test:coverage` | Check backend test coverage |
| `npm run test:e2e` | Run desktop and mobile browser tests |
| `npm run screenshots` | Rebuild the README screenshots with isolated demo data |
| `npm run dev` | Dev mode with hot reload |

### Refreshing the screenshots

```bash
npm run screenshots
```

Requires Google Chrome. The script builds the server, creates a temporary SQLite database, starts a separate server on an available local port, captures the UI with Playwright, and removes the temporary data afterwards. It does not change a running board or its database. Images are written to `docs/board.png`, `docs/overview.png`, `docs/ticket-split-view.png`, `docs/ticket-split-view-dark.png`, `docs/notifications.png`, `docs/ticket-html-draft.png`, `docs/ticket-process-diagram.png` and `docs/process-diagram-large.png`. The draft and process diagram examples are created through the REST API of the temporary server after the first five captures.

## Tech Stack

- **Backend**: TypeScript, Express, better-sqlite3, Apollo Server, graphql-ws
- **Frontend**: Vanilla JS, CSS with glassmorphism design
- **MCP**: `@modelcontextprotocol/sdk` (StreamableHTTP transport)
- **Tests**: Vitest and Playwright

## License

MIT
