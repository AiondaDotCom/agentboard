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
import { registerMcpTools, getOrCreateMcpAgent } from './mcp-server.js';
import { typeDefs } from './graphql/schema.js';
import { createResolvers } from './graphql/resolvers.js';
import { createAgentRoutes } from './api/routes/agents.js';
import { createProjectRoutes } from './api/routes/projects.js';
import { createTicketRoutes, createHumanTicketRoutes } from './api/routes/tickets.js';
import { createAuditRoutes } from './api/routes/audit.js';
import { createAuditMiddleware } from './api/middleware/audit.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

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

// Audit middleware – logs every API call (infrastructure, stays at HTTP layer)
app.use('/api', createAuditMiddleware(db));

// REST routes – all go through the service layer
app.use('/api/agents', createAgentRoutes(service));
app.use('/api/projects', createProjectRoutes(service));
app.use('/api/projects/:id', createTicketRoutes(service));
app.use('/api/projects/:id', createHumanTicketRoutes(service));
app.use('/api/audit', createAuditRoutes(service));

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
// ---------------------------------------------------------------------------
const MCP_AGENT_NAME = process.env['AGENTBOARD_AGENT'] || 'mcp-agent';
const mcpAgentId = getOrCreateMcpAgent(service, MCP_AGENT_NAME);

// Session-based transport map
const mcpTransports: Record<string, StreamableHTTPServerTransport> = {};

function createMcpServerInstance(): McpServer {
  const mcp = new McpServer({ name: 'agentboard', version: '1.0.0' });
  registerMcpTools(mcp, service, mcpAgentId, MCP_AGENT_NAME);
  return mcp;
}

// POST /mcp – JSON-RPC messages + initialization
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    if (sessionId && mcpTransports[sessionId]) {
      await mcpTransports[sessionId].handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          mcpTransports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete mcpTransports[sid];
      };

      const mcp = createMcpServerInstance();
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
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !mcpTransports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await mcpTransports[sessionId].handleRequest(req, res);
});

// DELETE /mcp – session termination
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !mcpTransports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await mcpTransports[sessionId].handleRequest(req, res);
});

// Static files
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, '..', 'public');
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
║  MCP Agent: ${MCP_AGENT_NAME.padEnd(43)}║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch((err: unknown) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { app, db, service, httpServer, ADMIN_API_KEY };
