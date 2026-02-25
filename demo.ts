#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// Agentboard Demo – plays back demo.json as if real agents are working
// Usage: npx tsx demo.ts [base_url]
// Admin key is read directly from SQLite – no need to pass it.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

// ---- Colors ----
const c = {
  cyan: '\x1b[0;36m',
  green: '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  magenta: '\x1b[0;35m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  nc: '\x1b[0m',
};

// ---- Read admin key from SQLite ----
const DB_PATH = path.join(currentDir, 'agentboard.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`${c.yellow}Database not found at ${DB_PATH}. Start the server first.${c.nc}`);
  process.exit(1);
}
const sqliteDb = new Database(DB_PATH, { readonly: true });
const row = sqliteDb.prepare("SELECT value FROM settings WHERE key = 'admin_api_key'").get() as { value: string } | undefined;
sqliteDb.close();

if (!row) {
  console.error(`${c.yellow}No admin key found in database. Start the server first.${c.nc}`);
  process.exit(1);
}

// ---- Config ----
const BASE_URL = process.argv[2] ?? 'http://localhost:3000';
const ADMIN_KEY = row.value;
const DEMO_FILE = path.join(currentDir, 'demo.json');

interface DemoAgent {
  name: string;
  role: string;
}

interface DemoStep {
  action: 'create_ticket' | 'move' | 'comment';
  agent: string;
  delay_ms: number;
  title?: string;
  description?: string;
  column?: string;
  ticket_index?: number;
  body?: string;
}

interface DemoConfig {
  title: string;
  description: string;
  agents: DemoAgent[];
  project: { name: string; description: string };
  steps: DemoStep[];
}

const demo: DemoConfig = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf-8'));

// ---- Helpers ----
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(method: string, url: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
  // Only send admin key for admin routes, agent key for agent routes
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  const finalHeaders = { ...baseHeaders, ...extraHeaders };

  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: finalHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`${method} ${url} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

/** Admin API call (includes X-Admin-Key) */
async function adminApi(method: string, url: string, body?: unknown): Promise<unknown> {
  return api(method, url, body, { 'X-Admin-Key': ADMIN_KEY });
}

// ---- Banner ----
console.log('');
console.log(`${c.cyan}${c.bold}  ╔══════════════════════════════════════╗${c.nc}`);
console.log(`${c.cyan}${c.bold}  ║     Agentboard Demo Playback         ║${c.nc}`);
console.log(`${c.cyan}${c.bold}  ╚══════════════════════════════════════╝${c.nc}`);
console.log('');
console.log(`${c.bold}${demo.title}${c.nc}`);
console.log(`${c.dim}${demo.description}${c.nc}`);
console.log('');

console.log(`${c.dim}  Admin key loaded from database${c.nc}`);
console.log('');

// ---- Cleanup: delete all existing projects and agents ----
console.log(`${c.dim}  Cleaning up old data...${c.nc}`);

const oldProjects = (await api('GET', '/api/projects')) as { id: string; name: string }[];
for (const p of oldProjects) {
  await adminApi('DELETE', `/api/projects/${p.id}`);
  console.log(`  ${c.dim}  Deleted project: ${p.name}${c.nc}`);
}

const oldAgents = (await api('GET', '/api/agents')) as { id: string; name: string }[];
for (const a of oldAgents) {
  await adminApi('DELETE', `/api/agents/${a.id}`);
  console.log(`  ${c.dim}  Deleted agent: ${a.name}${c.nc}`);
}

console.log('');

// ---- Create agents ----
const agentKeys = new Map<string, string>();

for (const agent of demo.agents) {
  const result = (await adminApi('POST', '/api/agents', { name: agent.name })) as { apiKey: string; id: string };
  agentKeys.set(agent.name, result.apiKey);
  console.log(`  ${c.cyan}+${c.nc} Agent ${c.bold}${agent.name}${c.nc} ${c.dim}(${agent.role})${c.nc} registered`);
}

console.log('');

// ---- Create project ----
const project = (await adminApi('POST', '/api/projects', {
  name: demo.project.name,
  description: demo.project.description,
})) as { id: string };

console.log(`  ${c.green}+${c.nc} Project ${c.bold}${demo.project.name}${c.nc} created`);
console.log(`  ${c.dim}  ${demo.project.description}${c.nc}`);
console.log('');
console.log(`${c.yellow}${c.bold}  Open the board in your browser and select the project!${c.nc}`);
console.log(`${c.dim}  ${BASE_URL}${c.nc}`);
console.log('');
await sleep(3000);

// ---- Play steps ----
const ticketIds: string[] = [];

for (const step of demo.steps) {
  const agentKey = agentKeys.get(step.agent) ?? '';
  const agentHeaders = { 'X-Api-Key': agentKey };

  switch (step.action) {
    case 'create_ticket': {
      const ticket = (await api('POST', `/api/projects/${project.id}/tickets`, {
        title: step.title,
        description: step.description,
        column: step.column,
      }, agentHeaders)) as { id: string };

      ticketIds.push(ticket.id);
      console.log(`  ${c.green}+${c.nc} ${c.bold}${step.agent}${c.nc} created ticket: ${c.bold}${step.title}${c.nc}`);
      break;
    }

    case 'move': {
      const tid = ticketIds[step.ticket_index ?? 0];
      await api('PATCH', `/api/projects/${project.id}/tickets/${tid}/move`, {
        column: step.column,
      }, agentHeaders);

      const display = (step.column ?? '').replace(/_/g, ' ').toUpperCase();
      console.log(`  ${c.yellow}>${c.nc} ${c.bold}${step.agent}${c.nc} moved ticket → ${c.yellow}${display}${c.nc}`);
      break;
    }

    case 'comment': {
      const tid = ticketIds[step.ticket_index ?? 0];
      await api('POST', `/api/projects/${project.id}/tickets/${tid}/comments`, {
        body: step.body,
      }, agentHeaders);

      console.log(`  ${c.magenta}#${c.nc} ${c.bold}${step.agent}${c.nc}: ${c.dim}${step.body}${c.nc}`);
      break;
    }
  }

  await sleep(step.delay_ms);
}

console.log('');
console.log(`${c.green}${c.bold}  Demo complete!${c.nc} All tasks done.`);
console.log('');
