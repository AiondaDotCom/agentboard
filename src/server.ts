import { createServer } from 'node:http';
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

import { AgentboardDB } from './db/database.js';
import { typeDefs } from './graphql/schema.js';
import { createResolvers } from './graphql/resolvers.js';
import { createAgentRoutes } from './api/routes/agents.js';
import { createProjectRoutes } from './api/routes/projects.js';
import { createTicketRoutes, createHumanTicketRoutes } from './api/routes/tickets.js';
import { createAuditRoutes } from './api/routes/audit.js';
import { createAuditMiddleware } from './api/middleware/audit.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new AgentboardDB();

// Admin key: stored in SQLite (generated once, persisted forever).
// Can be overridden via env var; if so, also persist it in DB.
const envKey = process.env['ADMIN_API_KEY'];
if (envKey) {
  db.setSetting('admin_api_key', envKey);
}
const ADMIN_API_KEY = db.getOrCreateAdminKey();

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app: express.Express = express();
app.use(cors());
app.use(express.json());

// Audit middleware – logs every API call
app.use('/api', createAuditMiddleware(db));

// REST routes (admin auth reads key from DB dynamically for key rotation support)
app.use('/api/agents', createAgentRoutes(db));
app.use('/api/projects', createProjectRoutes(db));
app.use('/api/projects/:id', createTicketRoutes(db));
app.use('/api/projects/:id', createHumanTicketRoutes(db));
app.use('/api/audit', createAuditRoutes(db));

// Activity log route
app.get('/api/projects/:id/activity', (req, res): void => {
  const projectId = String(req.params['id'] ?? '');
  const project = db.getProject(projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const activities = db.getActivitiesByProject(projectId);
  res.json(activities);
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

export { app, db, httpServer, ADMIN_API_KEY };
