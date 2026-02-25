import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { useServer } from 'graphql-ws/lib/use/ws';
import { WebSocketServer } from 'ws';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { IResolvers } from '@graphql-tools/utils';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { AgentboardDB } from './db/database.js';
import { BoardService } from './services/board.service.js';
import { registerMcpTools } from './mcp-server.js';
import { typeDefs } from './graphql/schema.js';
import { createResolvers } from './graphql/resolvers.js';
import { createAgentRoutes } from './api/routes/agents.js';
import { createProjectRoutes } from './api/routes/projects.js';
import { createTicketRoutes, createHumanTicketRoutes } from './api/routes/tickets.js';
import { createAuditRoutes } from './api/routes/audit.js';
import { createAuditMiddleware } from './api/middleware/audit.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

// ---------------------------------------------------------------------------
// Session management (in-memory – sessions reset on server restart)
// ---------------------------------------------------------------------------
const sessions = new Set<string>();

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((c) => {
      const [key, ...rest] = c.trim().split('=');
      return [key, rest.join('=')];
    }),
  );
}

// ---------------------------------------------------------------------------
// Database + Service layer
// ---------------------------------------------------------------------------
const db = new AgentboardDB();
const service = new BoardService(db);

// Admin key: stored in SQLite (generated once, persisted forever).
const envKey = process.env['ADMIN_API_KEY'];
if (envKey) {
  db.setSetting('admin_api_key', envKey);
}
const ADMIN_API_KEY = service.getOrCreateAdminKey();

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app: express.Express = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Auth routes (public – no session required)
// ---------------------------------------------------------------------------
app.post('/api/auth/login', (req, res): void => {
  const { key } = req.body ?? {};
  if (typeof key === 'string' && key === ADMIN_API_KEY) {
    const token = randomUUID();
    sessions.add(token);
    res.setHeader('Set-Cookie', `agentboard_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid admin key' });
  }
});

app.post('/api/auth/logout', (req, res): void => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['agentboard_session'];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'agentboard_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res): void => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['agentboard_session'];
  res.json({ authenticated: !!(token && sessions.has(token)) });
});

// Audit middleware – logs every API call (infrastructure, stays at HTTP layer)
app.use('/api', createAuditMiddleware(db));

// REST routes – all go through the service layer
app.use('/api/agents', createAgentRoutes(service));
app.use('/api/projects', createProjectRoutes(service));
app.use('/api/projects/:id', createTicketRoutes(service));
app.use('/api/projects/:id', createHumanTicketRoutes(service));
app.use('/api/audit', createAuditRoutes(service));

// Agent keys route (session-protected – only for authenticated admin UI)
app.get('/api/agents/keys', (req, res): void => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['agentboard_session'];
  if (!token || !sessions.has(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const agentsWithKeys = service.getAllAgentsWithKeys();
  res.json(agentsWithKeys);
});

// Activity log route
app.get('/api/projects/:id/activity', (req, res): void => {
  try {
    const projectId = String(req.params['id'] ?? '');
    const activities = service.getActivitiesByProject(projectId);
    res.json(activities);
  } catch {
    res.status(404).json({ error: 'Project not found' });
  }
});

// ---------------------------------------------------------------------------
// MCP Server (embedded, same process – shares PubSub for realtime)
//
// Every MCP request requires X-Api-Key header with a valid agent API key.
// The agent identity is bound to the MCP session on initialization.
// ---------------------------------------------------------------------------

// Per-session state: transport + agent identity
interface McpSession {
  transport: StreamableHTTPServerTransport;
  agentId: string;
}
const mcpSessions: Record<string, McpSession> = {};

/** Validate X-Api-Key header and return the agent, or send 401/403. */
function authenticateMcpRequest(
  req: express.Request,
  res: express.Response,
): { id: string; name: string } | null {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (!apiKey) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Missing X-Api-Key header' },
      id: null,
    });
    return null;
  }
  const agent = service.getAgentByApiKey(apiKey);
  if (!agent) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Invalid API key' },
      id: null,
    });
    return null;
  }
  return agent;
}

// POST /mcp – JSON-RPC messages + initialization
app.post('/mcp', async (req, res) => {
  const agent = authenticateMcpRequest(req, res);
  if (!agent) return;

  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    if (sessionId && mcpSessions[sessionId]) {
      // Verify same agent owns this session
      if (mcpSessions[sessionId].agentId !== agent.id) {
        res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32002, message: 'Session belongs to a different agent' },
          id: null,
        });
        return;
      }
      await mcpSessions[sessionId].transport.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          mcpSessions[sid] = { transport, agentId: agent.id };
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete mcpSessions[sid];
      };

      const mcp = new McpServer({ name: 'agentboard', version: '1.0.0' });
      registerMcpTools(mcp, service, agent.id, agent.name);
      await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID' },
        id: null,
      });
    }
  } catch {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// GET /mcp – SSE stream for server notifications
app.get('/mcp', async (req, res) => {
  const agent = authenticateMcpRequest(req, res);
  if (!agent) return;

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !mcpSessions[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  if (mcpSessions[sessionId].agentId !== agent.id) {
    res.status(403).send('Session belongs to a different agent');
    return;
  }
  await mcpSessions[sessionId].transport.handleRequest(req, res);
});

// DELETE /mcp – session termination
app.delete('/mcp', async (req, res) => {
  const agent = authenticateMcpRequest(req, res);
  if (!agent) return;

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !mcpSessions[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  if (mcpSessions[sessionId].agentId !== agent.id) {
    res.status(403).send('Session belongs to a different agent');
    return;
  }
  await mcpSessions[sessionId].transport.handleRequest(req, res);
});

// ---------------------------------------------------------------------------
// Session guard – protects UI (static files + GraphQL). API & MCP are above.
// ---------------------------------------------------------------------------
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, '..', 'public');

app.use((req, res, next): void => {
  // Login page is always accessible
  if (req.path === '/login.html') { next(); return; }

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['agentboard_session'];
  if (token && sessions.has(token)) { next(); return; }

  // Non-HTML requests (JS, CSS, images) from unauthenticated clients → 401
  const accept = req.headers.accept ?? '';
  if (!accept.includes('text/html')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.redirect('/login.html');
});

// Static files
app.use(express.static(publicDir));

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const httpServer = createServer(app);

// ---------------------------------------------------------------------------
// GraphQL (Apollo + graphql-ws)
// ---------------------------------------------------------------------------
const schema = makeExecutableSchema({
  typeDefs,
  resolvers: createResolvers(db) as IResolvers,
});

const wsServer = new WebSocketServer({
  server: httpServer,
  path: '/graphql',
} as ConstructorParameters<typeof WebSocketServer>[0]);

const serverCleanup = useServer({ schema }, wsServer as unknown as Parameters<typeof useServer>[1]);

const apollo = new ApolloServer({
  schema,
  plugins: [
    {
      async serverWillStart() {
        return {
          async drainServer() {
            await serverCleanup.dispose();
          },
        };
      },
    },
  ],
});

async function start(): Promise<void> {
  await apollo.start();

  app.use(
    '/graphql',
    expressMiddleware(apollo) as unknown as express.RequestHandler,
  );

  httpServer.listen(PORT, () => {
    console.info(`
╔═══════════════════════════════════════════════════════════╗
║              🤖  A G E N T B O A R D  🤖                ║
╠═══════════════════════════════════════════════════════════╣
║  HTTP:      http://localhost:${PORT}                       ║
║  GraphQL:   http://localhost:${PORT}/graphql                ║
║  WebSocket: ws://localhost:${PORT}/graphql                  ║
║  MCP:       http://localhost:${PORT}/mcp                    ║
╠═══════════════════════════════════════════════════════════╣
║  Admin Key: ${ADMIN_API_KEY}  ║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch((err: unknown) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { app, db, service, httpServer, ADMIN_API_KEY };
