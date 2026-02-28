// ---------------------------------------------------------------------------
// Agentboard – shared type definitions
// ---------------------------------------------------------------------------

/** Kanban column a ticket can live in. */
export type Column =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'done';

/** Ordered list of every valid column value. */
export const VALID_COLUMNS = [
  'backlog',
  'ready',
  'in_progress',
  'in_review',
  'done',
] as const;

/** Type-guard that narrows an unknown value to `Column`. */
export function isValidColumn(value: unknown): value is Column {
  return (
    typeof value === 'string' &&
    (VALID_COLUMNS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

/** Filter & pagination options for listing tickets. */
export interface TicketListOptions {
  /** Filter by column (e.g. 'in_review', 'done'). */
  column?: Column | undefined;
  /** Page number (1-based). Default: 1. */
  page?: number | undefined;
  /** Items per page. Default: 50. */
  per_page?: number | undefined;
}

/** Paginated result wrapper. */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

// ---------------------------------------------------------------------------
// Domain entities
// ---------------------------------------------------------------------------

export interface Agent {
  id: string;
  name: string;
  apiKey: string;
  createdAt: string;
}

/** Agent representation safe for API responses (no secret key). */
export type AgentPublic = Omit<Agent, 'apiKey'>;

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface Ticket {
  id: string;
  projectId: string;
  title: string;
  description: string;
  column: Column;
  position: number;
  agentId: string | null;
  assigneeId: string | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  ticketId: string;
  agentId: string;
  body: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Ticket revisions (tamper-proof audit trail)
// ---------------------------------------------------------------------------

export interface TicketRevision {
  id: string;
  ticketId: string;
  agentId: string | null;
  field: string;
  oldValue: string;
  newValue: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export type ActivityAction =
  | 'ticket_created'
  | 'ticket_updated'
  | 'ticket_moved'
  | 'ticket_deleted'
  | 'ticket_assigned'
  | 'ticket_unassigned'
  | 'comment_added'
  | 'project_read'
  | 'tickets_listed'
  | 'ticket_read'
  | 'comments_read'
  | 'history_read';

export interface Activity {
  id: string;
  agentId: string | null;
  ticketId: string | null;
  action: ActivityAction;
  details: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Audit log (every API call)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  agentId: string | null;
  method: string;
  path: string;
  statusCode: number;
  requestBody: string;
  timestamp: string;
}
