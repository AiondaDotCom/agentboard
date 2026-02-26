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
// Session management (persistent in SQLite)
// ---------------------------------------------------------------------------
const TEN_YEARS = 10 * 365 * 24 * 3600;

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
const DB_PATH = process.env['DB_PATH'] || 'agentboard.db';
const db = new AgentboardDB(DB_PATH);
const service = new BoardService(db);

// Clean up MCP sessions older than 30 days
db.pruneOldMcpSessions(30);

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
    db.createSession(token);
    res.setHeader('Set-Cookie', `agentboard_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TEN_YEARS}`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid admin key' });
  }
});

app.post('/api/auth/logout', (req, res): void => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['agentboard_session'];
  if (token) db.deleteSession(token);
  res.setHeader('Set-Cookie', 'agentboard_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res): void => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['agentboard_session'];
  res.json({ authenticated: !!(token && db.hasSession(token)) });
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
  if (!token || !db.hasSession(token)) {
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
      error: {
        code: -32001,
        message: 'Missing X-Api-Key header. Every MCP request must include an X-Api-Key header with a valid agent API key. Example: -H "X-Api-Key: ab-your-key-here"',
        data: { recovery: 'add_api_key_header' },
      },
      id: null,
    });
    return null;
  }
  const agent = service.getAgentByApiKey(apiKey);
  if (!agent) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: {
        code: -32002,
        message: `Invalid API key "${apiKey.slice(0, 8)}...". This key is not registered. Check your API key or ask the admin to verify it in the Agentboard UI under "agents".`,
        data: { recovery: 'check_api_key' },
      },
      id: null,
    });
    return null;
  }
  return agent;
}

/** Helper: create a new MCP transport + server for an agent. */
async function createMcpTransport(
  agentId: string,
  agentName: string,
): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
      mcpSessions[sid] = { transport, agentId };
      db.createMcpSession(sid, agentId);
    },
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      delete mcpSessions[sid];
      db.deleteMcpSession(sid);
    }
  };

  const mcp = new McpServer({ name: 'agentboard', version: '1.0.0' });
  registerMcpTools(mcp, service, agentId, agentName);
  await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
  return transport;
}

/** Helper: build an LLM-friendly JSON-RPC error response. */
function mcpError(
  res: express.Response,
  status: number,
  code: number,
  message: string,
  data: Record<string, string>,
  reqId?: unknown,
): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message, data },
    id: reqId ?? null,
  });
}

// POST /mcp – JSON-RPC messages + initialization
app.post('/mcp', async (req, res) => {
  // Check Accept header before SDK does (SDK returns a cryptic 406)
  const accept = req.headers.accept ?? '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    mcpError(res, 406, -32000,
      'Missing required Accept header. Your HTTP request must include the header: Accept: application/json, text/event-stream — This is required by the MCP StreamableHTTP transport. Most MCP client libraries set this automatically. If you are using curl or a raw HTTP client, add: -H "Accept: application/json, text/event-stream"',
      { recovery: 'add_accept_header', required_header: 'Accept: application/json, text/event-stream' },
      req.body?.id);
    return;
  }

  const agent = authenticateMcpRequest(req, res);
  if (!agent) return;

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const reqId = req.body?.id;

  try {
    // Case 1: Active in-memory session
    if (sessionId && mcpSessions[sessionId]) {
      if (mcpSessions[sessionId].agentId !== agent.id) {
        mcpError(res, 403, -32002, 'Session belongs to a different agent. Use the X-Api-Key that created this session, or send a new "initialize" request to start a fresh session.', { recovery: 'send_initialize', reason: 'wrong_agent' }, reqId);
        return;
      }
      db.touchMcpSession(sessionId);
      await mcpSessions[sessionId].transport.handleRequest(req, res, req.body);
      return;
    }

    // Case 2: Initialize request → create new session
    if (isInitializeRequest(req.body)) {
      const transport = await createMcpTransport(agent.id, agent.name);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Case 3: Stale session (known in DB but lost from memory after restart)
    if (sessionId) {
      const persistedAgentId = db.getMcpSessionAgentId(sessionId);

      if (persistedAgentId) {
        if (persistedAgentId !== agent.id) {
          mcpError(res, 403, -32002, 'Session belongs to a different agent.', { recovery: 'send_initialize', reason: 'wrong_agent' }, reqId);
          return;
        }
        db.deleteMcpSession(sessionId);
        // Return 404 so MCP SDK clients (like Claude Code) auto-reinitialize
        mcpError(res, 404, -32004,
          'MCP session expired because the server was restarted. Your API key is still valid. Action required: Send a new JSON-RPC "initialize" request to POST /mcp with your X-Api-Key header. A new session will be created automatically. You do NOT need to change your API key or any other configuration.',
          { recovery: 'send_initialize', reason: 'server_restart' }, reqId);
        return;
      }

      // Completely unknown session ID
      mcpError(res, 404, -32003,
        'Unknown MCP session ID – this session has never existed or was already deleted. Action required: Send a new JSON-RPC "initialize" request (method: "initialize") to POST /mcp with your X-Api-Key header to create a new session.',
        { recovery: 'send_initialize', reason: 'unknown_session' }, reqId);
      return;
    }

    // Case 4: No session ID and not an initialize request
    mcpError(res, 400, -32000,
      'Missing MCP session. You must first establish a session before calling tools. Action required: Send a JSON-RPC "initialize" request (method: "initialize") to POST /mcp with your X-Api-Key header. The server will respond with an Mcp-Session-Id header – include that header in all subsequent requests.',
      { recovery: 'send_initialize', reason: 'no_session' }, reqId);
  } catch {
    if (!res.headersSent) {
      mcpError(res, 500, -32603,
        'Internal server error. Please retry your request. If the error persists, try sending a fresh "initialize" request.',
        { recovery: 'retry_or_reinitialize' }, reqId);
    }
  }
});

// GET /mcp – SSE stream for server notifications
app.get('/mcp', async (req, res) => {
  const agent = authenticateMcpRequest(req, res);
  if (!agent) return;

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !mcpSessions[sessionId]) {
    const reason = sessionId
      ? (db.getMcpSessionAgentId(sessionId) ? 'server_restart' : 'unknown_session')
      : 'no_session';
    mcpError(res, 400, -32000,
      'Invalid or missing MCP session ID. Action required: Send a new "initialize" request to POST /mcp with your X-Api-Key header first.',
      { recovery: 'send_initialize', reason });
    return;
  }
  if (mcpSessions[sessionId].agentId !== agent.id) {
    mcpError(res, 403, -32002, 'Session belongs to a different agent.', { recovery: 'send_initialize', reason: 'wrong_agent' });
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
    if (sessionId) db.deleteMcpSession(sessionId);
    mcpError(res, 400, -32000, 'Invalid or missing session ID.', { recovery: 'send_initialize' });
    return;
  }
  if (mcpSessions[sessionId].agentId !== agent.id) {
    mcpError(res, 403, -32002, 'Session belongs to a different agent.', { recovery: 'send_initialize', reason: 'wrong_agent' });
    return;
  }
  db.deleteMcpSession(sessionId);
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
  if (token && db.hasSession(token)) { next(); return; }

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
