// ---------------------------------------------------------------------------
// Agentboard – shared type definitions
// ---------------------------------------------------------------------------

/**
 * Kanban column id a ticket can live in. Columns are configured per project
 * (see Project.columns), so this is an open string – validation happens in
 * the service layer against the owning project's column set.
 */
export type Column = string;

/** A single board column as configured on a project. */
export interface ColumnDef {
  /** Stable slug used in ticket.column (e.g. 'in_progress'). */
  id: string;
  /** Display name shown in the UI (e.g. 'In Progress'). */
  title: string;
}

/**
 * Default column set for new projects.
 * Convention: the FIRST column is where new tickets land and where reopened
 * tickets go; the LAST column counts as "finished" (releases group claims).
 */
export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'blocked', title: 'Blocked' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'rework', title: 'Rework' },
  { id: 'in_review', title: 'In Review' },
  { id: 'done', title: 'Done' },
];

/** Column set of projects created before per-project columns existed. */
export const LEGACY_COLUMNS: ColumnDef[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready', title: 'Ready' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'in_review', title: 'In Review' },
  { id: 'done', title: 'Done' },
];

/** Allowed shape for column ids: lowercase slug, max 32 chars. */
export const COLUMN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

/** Filter & pagination options for listing tickets. */
export interface TicketListOptions {
  /** Filter by column id (e.g. 'in_review', 'done'). */
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
  /** Ordered board columns. First = inbox for new tickets, last = finished. */
  columns: ColumnDef[];
  createdAt: string;
}

export interface Ticket {
  id: string;
  projectId: string;
  title: string;
  description: string;
  column: Column;
  position: number;
  /** Optional group name – tickets in the same group are claimed by one agent. */
  group: string | null;
  /** Why the ticket cannot proceed (external dependency). Null when not blocked. */
  blockedReason: string | null;
  /**
   * Ticket ids this ticket depends on. While any of them is not in the last
   * (finished) column, this ticket may only live in the first column.
   */
  dependsOn: string[];
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
  | 'project_updated'
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
