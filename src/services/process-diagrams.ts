import { randomUUID } from 'node:crypto';
import type { AgentboardDB } from '../db/database.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

// Simplified BPMN for the business process a ticket describes: lanes (who),
// start/end events, tasks and decisions (exclusive gateways), sequence flows.
// Agents send this small structure; the board lays it out and draws it.

export const PROCESS_DIAGRAM_INSTRUCTIONS =
  'Use save_process_diagram to attach a simplified BPMN diagram of the BUSINESS PROCESS the ticket describes (not the ticket workflow). Lanes are the actors (e.g. User, App, Server, AI). Node types: start, end, task, decision. Every node belongs to one lane. Flows connect node ids; label the outgoing flows of a decision (e.g. "yes"/"no", "valid"/"invalid"). Include error and cancel paths. Keep labels short (a verb phrase, at most ~6 words). The board assigns every step a sub-ID (S1, S2, …) and every flow one (F1, F2, …); the user quotes these to point at a step, so keep node ids stable when revising. Use one diagram per user-visible flow (e.g. \"Create folder\", \"Improve description\"). To change a diagram, send diagram_id plus expected_version; each save is a new immutable version.';

export const NODE_TYPES = ['start', 'end', 'task', 'decision'] as const;
export type ProcessNodeType = (typeof NODE_TYPES)[number];

export interface ProcessLane {
  id: string;
  name: string;
}
export interface ProcessNode {
  id: string;
  type: ProcessNodeType;
  label: string;
  lane: string;
  /** Server-assigned sub-ID (S1, S2, …), stable across versions for the same node id. */
  ref?: string;
}
export interface ProcessFlow {
  from: string;
  to: string;
  label?: string;
  /** Server-assigned sub-ID (F1, F2, …), stable across versions for the same from→to pair. */
  ref?: string;
}
export interface ProcessDiagramInput {
  lanes: ProcessLane[];
  nodes: ProcessNode[];
  flows: ProcessFlow[];
}
/**
 * Gives every node and flow a short sub-ID the user can quote to an AI ("S4 is wrong").
 * Elements that survive into a new version keep their sub-ID; new ones get the next number.
 */
export function assignRefs(diagram: ProcessDiagramInput, previous?: ProcessDiagramInput): ProcessDiagramInput {
  const number = (ref: string | undefined): number => Number(ref?.slice(1)) || 0;
  const oldNodes = new Map((previous?.nodes ?? []).map((n) => [n.id, n.ref]));
  const oldFlows = new Map((previous?.flows ?? []).map((f) => [`${f.from}>${f.to}`, f.ref]));
  let nextNode = Math.max(0, ...(previous?.nodes ?? []).map((n) => number(n.ref)));
  let nextFlow = Math.max(0, ...(previous?.flows ?? []).map((f) => number(f.ref)));
  return {
    lanes: diagram.lanes,
    nodes: diagram.nodes.map((n) => ({ ...n, ref: oldNodes.get(n.id) ?? `S${String(++nextNode)}` })),
    flows: diagram.flows.map((f) => ({ ...f, ref: oldFlows.get(`${f.from}>${f.to}`) ?? `F${String(++nextFlow)}` })),
  };
}

export interface ProcessDiagramVersion extends ProcessDiagramInput {
  id: string;
  ticketId: string;
  version: number;
  title: string;
  createdAt: string;
  agentId: string;
}

export const LIMITS = { lanes: 8, nodes: 80, flows: 160, label: 120, title: 200 };
const ID = /^[A-Za-z0-9_-]{1,40}$/;

function label(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new ValidationError(`${name} must be nonempty text of at most ${String(max)} characters`);
  return value.trim();
}

function optionalLabel(value: unknown, name: string, max: number): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : label(value, name, max);
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value))
    throw new ValidationError(`${name} must match ${ID.source}`);
  return value;
}

function list(value: unknown, name: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new ValidationError(`${name} must be an array with ${String(min)}–${String(max)} entries`);
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

/** Validates and normalises an agent-supplied diagram. Throws on any defect. */
export function validateDiagram(input: unknown): ProcessDiagramInput {
  const raw = record(input, 'diagram');
  const laneIds = new Set<string>();
  const lanes = list(raw['lanes'], 'lanes', 1, LIMITS.lanes).map((value, i) => {
    const lane = record(value, `lanes[${String(i)}]`);
    const id = identifier(lane['id'], `lanes[${String(i)}].id`);
    if (laneIds.has(id)) throw new ValidationError(`Duplicate lane id "${id}"`);
    laneIds.add(id);
    return { id, name: label(lane['name'], `lanes[${String(i)}].name`, 60) };
  });
  const nodeIds = new Set<string>();
  const nodes = list(raw['nodes'], 'nodes', 2, LIMITS.nodes).map((value, i) => {
    const node = record(value, `nodes[${String(i)}]`);
    const id = identifier(node['id'], `nodes[${String(i)}].id`);
    if (nodeIds.has(id)) throw new ValidationError(`Duplicate node id "${id}"`);
    nodeIds.add(id);
    const type = node['type'];
    if (!NODE_TYPES.includes(type as ProcessNodeType))
      throw new ValidationError(`nodes[${String(i)}].type must be one of ${NODE_TYPES.join(', ')}`);
    const lane = identifier(node['lane'], `nodes[${String(i)}].lane`);
    if (!laneIds.has(lane)) throw new ValidationError(`Node "${id}" references unknown lane "${lane}"`);
    return { id, type: type as ProcessNodeType, lane, label: label(node['label'], `nodes[${String(i)}].label`, LIMITS.label) };
  });
  if (!nodes.some((n) => n.type === 'start')) throw new ValidationError('At least one start event is required');
  if (!nodes.some((n) => n.type === 'end')) throw new ValidationError('At least one end event is required');
  const seen = new Set<string>();
  const flows = list(raw['flows'], 'flows', 1, LIMITS.flows).map((value, i) => {
    const flow = record(value, `flows[${String(i)}]`);
    const from = identifier(flow['from'], `flows[${String(i)}].from`);
    const to = identifier(flow['to'], `flows[${String(i)}].to`);
    if (!nodeIds.has(from) || !nodeIds.has(to))
      throw new ValidationError(`Flow ${from} → ${to} references an unknown node`);
    if (from === to) throw new ValidationError(`Flow ${from} → ${to} loops onto itself`);
    if (seen.has(`${from}>${to}`)) throw new ValidationError(`Duplicate flow ${from} → ${to}`);
    seen.add(`${from}>${to}`);
    const text = optionalLabel(flow['label'], `flows[${String(i)}].label`, 60);
    return text === undefined ? { from, to } : { from, to, label: text };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const flow of flows) {
    if (byId.get(flow.to)?.type === 'start') throw new ValidationError(`Start event "${flow.to}" cannot have incoming flows`);
    if (byId.get(flow.from)?.type === 'end') throw new ValidationError(`End event "${flow.from}" cannot have outgoing flows`);
  }
  // Every node must be reachable from a start event, otherwise the drawing lies.
  const reached = new Set(nodes.filter((n) => n.type === 'start').map((n) => n.id));
  const queue = [...reached];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const flow of flows)
      if (flow.from === current && !reached.has(flow.to)) {
        reached.add(flow.to);
        queue.push(flow.to);
      }
  }
  const orphans = nodes.filter((n) => !reached.has(n.id)).map((n) => n.id);
  if (orphans.length) throw new ValidationError(`Not reachable from a start event: ${orphans.join(', ')}`);
  for (const node of nodes) {
    if (node.type !== 'end' && !flows.some((f) => f.from === node.id))
      throw new ValidationError(`Node "${node.id}" has no outgoing flow; end the path with an end event`);
    if (node.type === 'decision' && flows.filter((f) => f.from === node.id).length < 2)
      throw new ValidationError(`Decision "${node.id}" needs at least two outgoing flows`);
  }
  return { lanes, nodes, flows };
}

export class ProcessDiagramService {
  constructor(
    private db: AgentboardDB,
    private changed: (projectId: string, ticketId: string, agentId: string | null, detail: string) => void,
  ) {}
  private ticket(projectId: string, ticketId: string): void {
    if (!this.db.getTicket(projectId, ticketId)) throw new NotFoundError('Ticket not found');
  }
  list(projectId: string, ticketId: string): ProcessDiagramVersion[] {
    this.ticket(projectId, ticketId);
    return this.db.listProcessDiagrams(ticketId);
  }
  get(projectId: string, ticketId: string, id: string, version: number): ProcessDiagramVersion {
    this.ticket(projectId, ticketId);
    if (!Number.isSafeInteger(version) || version < 1) throw new ValidationError('Invalid diagram version');
    const diagram = this.db.getProcessDiagram(id, version);
    if (diagram?.ticketId !== ticketId) throw new NotFoundError('Diagram version not found');
    return diagram;
  }
  save(
    projectId: string,
    ticketId: string,
    title: unknown,
    input: unknown,
    agentId: string,
    id?: string,
    expectedVersion?: number,
  ): ProcessDiagramVersion {
    this.ticket(projectId, ticketId);
    const name = label(title, 'title', LIMITS.title);
    let diagram = validateDiagram(input);
    let version = 1;
    if (id !== undefined) {
      const current = this.db.latestProcessDiagram(id);
      if (current?.ticketId !== ticketId) throw new NotFoundError('Diagram not found');
      if (expectedVersion !== current.version)
        throw new ConflictError('Diagram changed; read latest version before saving');
      version = current.version + 1;
      diagram = assignRefs(diagram, current);
    } else diagram = assignRefs(diagram);
    if (id === undefined && expectedVersion !== undefined)
      throw new ValidationError('expected_version requires diagram_id');
    const saved: ProcessDiagramVersion = {
      id: id ?? randomUUID(),
      ticketId,
      version,
      title: name,
      ...diagram,
      agentId,
      createdAt: new Date().toISOString(),
    };
    this.db.saveProcessDiagram(saved);
    this.changed(projectId, ticketId, agentId, `Process diagram: ${name} v${String(version)}`);
    return saved;
  }
}
