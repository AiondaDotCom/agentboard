# BAUPLAN – Agentboard

```
    ╔═══════════════════════════════════════════════════════════╗
    ║              🤖  A G E N T B O A R D  🤖                ║
    ║         Lightweight Kanban for AI Agents                  ║
    ╚═══════════════════════════════════════════════════════════╝
```

## 1. Konzept

Ein Kanban Board, das **von AI Agents gesteuert** wird und **von Menschen beobachtet** wird.

```
    ┌─────────┐    REST API     ┌──────────────┐    GraphQL/WS     ┌─────────────┐
    │ AI Agent │ ──────────────▶ │  Agentboard  │ ◀────────────────▶ │   Browser   │
    │ (clawbot)│  (read/write)  │    Server     │   (read-only)     │  (Human UI) │
    └─────────┘                 └──────────────┘                    └─────────────┘
    ┌─────────┐                        │
    │ AI Agent │ ──────────────────────┘
    │ (andere) │    REST API
    └─────────┘
```

### Rollen

| Rolle       | Zugriff                  | Auth                |
|-------------|--------------------------|---------------------|
| **Human**   | UI read-only + GraphQL   | Keine (open)        |
| **Human**   | Tickets öffnen/schließen | Über UI (kein Key)  |
| **AI Agent**| REST API (full CRUD)     | API-Key im Header   |

---

## 2. Tech Stack

| Komponente    | Technologie                                |
|---------------|--------------------------------------------|
| **Language**  | TypeScript (strict mode)                   |
| **Backend**   | Node.js + Express                          |
| **API**       | REST (Agents) + GraphQL (Human UI)         |
| **Realtime**  | GraphQL Subscriptions (WebSocket)          |
| **Database**  | SQLite (via better-sqlite3)                |
| **Frontend**  | Vanilla HTML/CSS/JS (kein Framework)       |
| **GraphQL**   | Apollo Server + apollo-client              |
| **Linting**   | ESLint flat config (ultra strict)          |
| **Testing**   | Vitest (unit, 80%+ coverage) + Playwright  |
| **Build**     | tsx (dev) + tsc (build)                    |

> SQLite = zero config, single file, perfekt für ein Lite-Board.
> Vanilla Frontend = keine Build-Tools nötig, einfach deployen.
> TypeScript strict = maximale Typsicherheit, keine implicit any.

---

## 3. Datenmodell

```
    ┌──────────────────┐
    │      agents       │
    ├──────────────────┤
    │ id          TEXT  │──┐
    │ name        TEXT  │  │
    │ api_key     TEXT  │  │
    │ created_at  TEXT  │  │
    └──────────────────┘  │
                           │
    ┌──────────────────┐  │    ┌──────────────────┐
    │     projects      │  │    │      tickets      │
    ├──────────────────┤  │    ├──────────────────┤
    │ id          TEXT  │──┼───▶│ project_id  TEXT  │
    │ name        TEXT  │  │    │ id          TEXT  │
    │ description TEXT  │  │    │ title       TEXT  │
    │ created_at  TEXT  │  │    │ description TEXT  │
    └──────────────────┘  │    │ column      TEXT  │
                           │    │ position    INT   │
                           │    │ agent_id    TEXT  │◀─┘
                           │    │ created_at  TEXT  │
                           │    │ updated_at  TEXT  │
                           │    └──────────────────┘
                           │
                           │    ┌──────────────────┐
                           │    │     comments       │
                           │    ├──────────────────┤
                           ├───▶│ id          TEXT  │
                           │    │ ticket_id   TEXT  │
                           │    │ agent_id    TEXT  │
                           │    │ body        TEXT  │
                           │    │ created_at  TEXT  │
                           │    └──────────────────┘
                           │
                           │    ┌──────────────────┐
                           │    │   activity_log    │
                           │    ├──────────────────┤
                           └───▶│ agent_id    TEXT  │
                                │ ticket_id   TEXT  │
                                │ action      TEXT  │
                                │ details     TEXT  │
                                │ timestamp   TEXT  │
                                └──────────────────┘
```

### Spalten (Columns)

Fest definiert, nicht konfigurierbar:

```
  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌──────────┐
  │ BACKLOG  │  │  READY   │  │ IN PROGRESS  │  │ IN REVIEW │  │   DONE   │
  │          │▶ │          │▶ │              │▶ │           │▶ │          │
  └──────────┘  └──────────┘  └──────────────┘  └───────────┘  └──────────┘
```

Column-Werte: `backlog`, `ready`, `in_progress`, `in_review`, `done`

---

## 4. REST API (für AI Agents)

Auth: `X-Api-Key: <agent-api-key>` Header

### Agents

```
POST   /api/agents              # Agent registrieren (name) → api_key
GET    /api/agents               # Alle Agents auflisten
```

### Projects

```
POST   /api/projects             # Projekt anlegen
GET    /api/projects             # Alle Projekte
GET    /api/projects/:id         # Einzelnes Projekt
DELETE /api/projects/:id         # Projekt löschen
```

### Tickets

```
POST   /api/projects/:id/tickets           # Ticket erstellen
GET    /api/projects/:id/tickets           # Alle Tickets eines Projekts
GET    /api/projects/:id/tickets/:ticketId # Einzelnes Ticket
PATCH  /api/projects/:id/tickets/:ticketId # Ticket updaten (title, desc, column)
DELETE /api/projects/:id/tickets/:ticketId # Ticket löschen
```

### Ticket verschieben (Shortcut)

```
PATCH  /api/projects/:id/tickets/:ticketId/move
Body:  { "column": "in_progress" }
```

### Comments

```
POST   /api/projects/:id/tickets/:ticketId/comments   # Kommentar erstellen
GET    /api/projects/:id/tickets/:ticketId/comments    # Alle Kommentare eines Tickets
```

### Activity Log

```
GET    /api/projects/:id/activity          # Activity Log eines Projekts
```

---

## 5. GraphQL Schema (für Human UI)

```graphql
type Agent {
  id: ID!
  name: String!
  createdAt: String!
}

type Ticket {
  id: ID!
  title: String!
  description: String
  column: String!
  position: Int!
  agent: Agent
  createdAt: String!
  updatedAt: String!
}

type Project {
  id: ID!
  name: String!
  description: String
  tickets: [Ticket!]!
  createdAt: String!
}

type Activity {
  id: ID!
  agent: Agent
  ticket: Ticket
  action: String!
  details: String
  timestamp: String!
}

type Query {
  projects: [Project!]!
  project(id: ID!): Project
  agents: [Agent!]!
}

type Subscription {
  ticketMoved(projectId: ID!): Ticket!
  ticketUpdated(projectId: ID!): Ticket!
  ticketCreated(projectId: ID!): Ticket!
  activityAdded(projectId: ID!): Activity!
}
```

---

## 6. Frontend (Human UI)

Read-only Kanban Board mit Realtime-Updates via GraphQL Subscriptions.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  AGENTBOARD  ─  Project: clawbot-tasks                     [projects ▾]│
├─────────────┬─────────────┬─────────────┬─────────────┬─────────────────┤
│  BACKLOG    │  READY      │ IN PROGRESS │  IN REVIEW  │  DONE           │
│             │             │             │             │                 │
│ ┌─────────┐│ ┌─────────┐ │ ┌─────────┐ │             │ ┌─────────┐    │
│ │ #3      ││ │ #5      │ │ │ #1      │ │             │ │ #2      │    │
│ │ Fix bug ││ │ Add API │ │ │ Refactor│ │             │ │ Setup   │    │
│ │         ││ │         │ │ │         │ │             │ │         │    │
│ │ 🤖 bot1 ││ │ 🤖 bot2  │ │ │ 🤖 bot1  │ │             │ │ 🤖 bot1  │    │
│ └─────────┘│ └─────────┘ │ └─────────┘ │             │ └─────────┘    │
│ ┌─────────┐│             │             │             │                 │
│ │ #4      ││             │             │             │                 │
│ │ Write   ││             │             │             │                 │
│ │ tests   ││             │             │             │                 │
│ │ 🤖 bot3  ││             │             │             │                 │
│ └─────────┘│             │             │             │                 │
├─────────────┴─────────────┴─────────────┴─────────────┴─────────────────┤
│  ACTIVITY: bot1 moved #1 from READY → IN PROGRESS           2 min ago  │
│            bot2 created #5 "Add API"                         5 min ago  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Features

- Projekt-Auswahl (Dropdown)
- 5 Spalten als Kanban-Lanes
- Tickets als Karten mit: ID, Title, zugewiesener Agent
- Activity Feed am unteren Rand (live)
- Tickets öffnen/schließen per Button (Human-Aktion, kein API-Key nötig)
- Animations wenn Tickets verschoben werden
- Dark Theme (default)

---

## 7. Projektstruktur

```
agentboard/
├── package.json
├── tsconfig.json              # TypeScript strict config
├── eslint.config.ts           # ESLint flat config (ultra strict)
├── vitest.config.ts           # Vitest + Coverage config
├── playwright.config.ts       # Playwright E2E config
├── src/
│   ├── server.ts              # Express + Apollo Server + WebSocket
│   ├── db/
│   │   ├── schema.sql         # SQLite Schema
│   │   └── database.ts        # DB-Verbindung + Queries
│   ├── api/
│   │   ├── routes/
│   │   │   ├── agents.ts      # REST: /api/agents
│   │   │   ├── projects.ts    # REST: /api/projects
│   │   │   └── tickets.ts     # REST: /api/tickets
│   │   └── middleware/
│   │       └── auth.ts        # API-Key Validation
│   ├── graphql/
│   │   ├── schema.ts          # GraphQL Type Definitions
│   │   ├── resolvers.ts       # Query + Subscription Resolvers
│   │   └── pubsub.ts          # PubSub für Subscriptions
│   └── types.ts               # Shared TypeScript Types
├── public/
│   ├── index.html             # Single Page
│   ├── style.css              # Dark Theme Kanban Styles
│   └── app.js                 # GraphQL Client + Realtime UI
├── tests/
│   ├── unit/
│   │   ├── database.test.ts   # DB Layer Tests
│   │   ├── agents.test.ts     # Agent Routes Tests
│   │   ├── projects.test.ts   # Project Routes Tests
│   │   ├── tickets.test.ts    # Ticket Routes Tests
│   │   └── auth.test.ts       # Auth Middleware Tests
│   └── e2e/
│       └── board.spec.ts      # Playwright E2E Tests
├── LICENSE
└── README.md
```

---

## 8. Umsetzungsreihenfolge

```
  Phase 1          Phase 2          Phase 3          Phase 4
 ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
 │ DB +     │    │ REST API │    │ GraphQL  │    │ Frontend │
 │ Schema   │───▶│ Agents,  │───▶│ Queries, │───▶│ Kanban   │
 │ Setup    │    │ Projects,│    │ Subscr.  │    │ Board UI │
 │          │    │ Tickets  │    │          │    │          │
 └──────────┘    └──────────┘    └──────────┘    └──────────┘
     npm init       CRUD für        Realtime        HTML/CSS/JS
     SQLite         alle Entities   WebSocket       Dark Theme
     Schema                         PubSub          Activity Feed
```

### Phase 1: Grundgerüst
- `npm init`, Dependencies installieren
- SQLite Schema erstellen
- DB-Verbindungsschicht

### Phase 2: REST API
- Agent-Registrierung mit API-Key-Generierung
- CRUD für Projects und Tickets
- Auth-Middleware für API-Key-Validierung
- Activity Logging

### Phase 3: GraphQL + Realtime
- GraphQL Schema + Resolvers
- Subscriptions via WebSocket (graphql-ws)
- PubSub-Events bei jeder REST-Mutation

### Phase 4: Frontend
- Kanban Board Layout (5 Spalten)
- GraphQL Subscription Client
- Live-Updates + Animations
- Activity Feed
- Ticket öffnen/schließen Buttons

---

## 9. Dependencies

```json
{
  "dependencies": {
    "express": "^4.18",
    "better-sqlite3": "^11",
    "@apollo/server": "^4",
    "graphql": "^16",
    "graphql-ws": "^5",
    "ws": "^8",
    "uuid": "^9",
    "cors": "^2"
  },
  "devDependencies": {
    "typescript": "^5.7",
    "tsx": "^4",
    "@types/express": "^5",
    "@types/better-sqlite3": "^7",
    "@types/uuid": "^10",
    "@types/cors": "^2",
    "@types/ws": "^8",
    "eslint": "^9",
    "@typescript-eslint/eslint-plugin": "^8",
    "@typescript-eslint/parser": "^8",
    "vitest": "^3",
    "@vitest/coverage-v8": "^3",
    "supertest": "^7",
    "@types/supertest": "^6",
    "playwright": "^1",
    "@playwright/test": "^1"
  }
}
```

---

## 10. Beispiel: Agent-Workflow

```
  ┌─────────────────────────────────────────────────────────────┐
  │  clawbot spawnt einen Agent                                 │
  │                                                             │
  │  1. POST /api/agents  { "name": "code-writer-1" }          │
  │     → { "id": "...", "api_key": "ab-XXXX..." }             │
  │                                                             │
  │  2. POST /api/projects  { "name": "feature-auth" }         │
  │     → { "id": "proj-123" }                                 │
  │                                                             │
  │  3. POST /api/projects/proj-123/tickets                     │
  │     { "title": "Implement login", "column": "backlog" }    │
  │     → { "id": "tkt-001" }                                  │
  │                                                             │
  │  4. PATCH /api/projects/proj-123/tickets/tkt-001/move       │
  │     { "column": "in_progress" }                             │
  │                                                             │
  │  5. Human sieht in Echtzeit: Ticket rutscht nach            │
  │     "IN PROGRESS" ──▶ Animation im Browser                  │
  │                                                             │
  │  6. Agent ist fertig:                                       │
  │     PATCH .../move  { "column": "in_review" }              │
  │                                                             │
  │  7. Human sieht Review-Ticket, prüft, klickt "Done" ✓      │
  └─────────────────────────────────────────────────────────────┘
```
