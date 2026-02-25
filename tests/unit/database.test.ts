import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentboardDB } from '../../src/db/database.js';

describe('AgentboardDB', () => {
  let db: AgentboardDB;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('agents', () => {
    it('should create an agent with a generated API key', () => {
      const agent = db.createAgent('test-bot');
      expect(agent.name).toBe('test-bot');
      expect(agent.id).toBeDefined();
      expect(agent.apiKey).toMatch(/^ab-/);
      expect(agent.createdAt).toBeDefined();
    });

    it('should throw on duplicate agent name', () => {
      db.createAgent('bot1');
      expect(() => db.createAgent('bot1')).toThrow();
    });

    it('should find agent by API key', () => {
      const created = db.createAgent('bot1');
      const found = db.getAgentByApiKey(created.apiKey);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });

    it('should return undefined for invalid API key', () => {
      expect(db.getAgentByApiKey('invalid')).toBeUndefined();
    });

    it('should get agent by ID (public, no apiKey)', () => {
      const created = db.createAgent('bot1');
      const found = db.getAgentById(created.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('bot1');
      expect((found as any).apiKey).toBeUndefined();
    });

    it('should return undefined for invalid ID', () => {
      expect(db.getAgentById('nonexistent')).toBeUndefined();
    });

    it('should list all agents without API keys', () => {
      db.createAgent('bot1');
      db.createAgent('bot2');
      const all = db.getAllAgents();
      expect(all).toHaveLength(2);
      expect(all[0]!.name).toBe('bot1');
      all.forEach(a => expect((a as any).apiKey).toBeUndefined());
    });
  });

  describe('projects', () => {
    it('should create a project', () => {
      const project = db.createProject('my-project', 'A description');
      expect(project.name).toBe('my-project');
      expect(project.description).toBe('A description');
      expect(project.id).toBeDefined();
    });

    it('should create a project with default empty description', () => {
      const project = db.createProject('p1');
      expect(project.description).toBe('');
    });

    it('should get a project by ID', () => {
      const created = db.createProject('p1');
      const found = db.getProject(created.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('p1');
    });

    it('should return undefined for invalid project ID', () => {
      expect(db.getProject('nonexistent')).toBeUndefined();
    });

    it('should list all projects', () => {
      db.createProject('p1');
      db.createProject('p2');
      const all = db.getAllProjects();
      expect(all).toHaveLength(2);
    });

    it('should delete a project', () => {
      const project = db.createProject('p1');
      expect(db.deleteProject(project.id)).toBe(true);
      expect(db.getProject(project.id)).toBeUndefined();
    });

    it('should return false when deleting nonexistent project', () => {
      expect(db.deleteProject('nonexistent')).toBe(false);
    });

    it('should cascade delete tickets when project is deleted', () => {
      const project = db.createProject('p1');
      db.createTicket(project.id, 'ticket1');
      db.deleteProject(project.id);
      expect(db.getTicketsByProject(project.id)).toHaveLength(0);
    });
  });

  describe('tickets', () => {
    let projectId: string;

    beforeEach(() => {
      projectId = db.createProject('test-project').id;
    });

    it('should create a ticket with defaults', () => {
      const ticket = db.createTicket(projectId, 'Fix bug');
      expect(ticket.title).toBe('Fix bug');
      expect(ticket.column).toBe('backlog');
      expect(ticket.position).toBe(0);
      expect(ticket.description).toBe('');
      expect(ticket.agentId).toBeNull();
    });

    it('should create a ticket with all fields', () => {
      const agent = db.createAgent('bot1');
      const ticket = db.createTicket(projectId, 'Task', 'desc', 'ready', agent.id);
      expect(ticket.column).toBe('ready');
      expect(ticket.description).toBe('desc');
      expect(ticket.agentId).toBe(agent.id);
    });

    it('should auto-increment position in same column', () => {
      const t1 = db.createTicket(projectId, 'First');
      const t2 = db.createTicket(projectId, 'Second');
      expect(t1.position).toBe(0);
      expect(t2.position).toBe(1);
    });

    it('should get a ticket by project and ticket ID', () => {
      const created = db.createTicket(projectId, 'Task');
      const found = db.getTicket(projectId, created.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe('Task');
    });

    it('should return undefined for wrong project ID', () => {
      const other = db.createProject('other').id;
      const ticket = db.createTicket(projectId, 'Task');
      expect(db.getTicket(other, ticket.id)).toBeUndefined();
    });

    it('should list tickets by project', () => {
      db.createTicket(projectId, 'T1');
      db.createTicket(projectId, 'T2');
      const tickets = db.getTicketsByProject(projectId);
      expect(tickets).toHaveLength(2);
    });

    it('should update ticket fields', () => {
      const ticket = db.createTicket(projectId, 'Old Title');
      const updated = db.updateTicket(projectId, ticket.id, {
        title: 'New Title',
        description: 'New Desc',
      });
      expect(updated).toBeDefined();
      expect(updated!.title).toBe('New Title');
      expect(updated!.description).toBe('New Desc');
    });

    it('should move ticket to new column', () => {
      const ticket = db.createTicket(projectId, 'Task');
      const moved = db.moveTicket(projectId, ticket.id, 'in_progress');
      expect(moved).toBeDefined();
      expect(moved!.column).toBe('in_progress');
    });

    it('should return undefined when updating nonexistent ticket', () => {
      expect(db.updateTicket(projectId, 'nonexistent', { title: 'x' })).toBeUndefined();
    });

    it('should delete a ticket', () => {
      const ticket = db.createTicket(projectId, 'Task');
      expect(db.deleteTicket(projectId, ticket.id)).toBe(true);
      expect(db.getTicket(projectId, ticket.id)).toBeUndefined();
    });

    it('should return false when deleting nonexistent ticket', () => {
      expect(db.deleteTicket(projectId, 'nonexistent')).toBe(false);
    });
  });

  describe('comments', () => {
    it('should create and list comments', () => {
      const project = db.createProject('p1');
      const agent = db.createAgent('bot1');
      const ticket = db.createTicket(project.id, 'Task');

      const comment = db.createComment(ticket.id, agent.id, 'Hello world');
      expect(comment.body).toBe('Hello world');
      expect(comment.agentId).toBe(agent.id);
      expect(comment.ticketId).toBe(ticket.id);

      const comments = db.getCommentsByTicket(ticket.id);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toBe('Hello world');
    });

    it('should return empty array for ticket with no comments', () => {
      const project = db.createProject('p1');
      const ticket = db.createTicket(project.id, 'Task');
      expect(db.getCommentsByTicket(ticket.id)).toHaveLength(0);
    });
  });

  describe('activity log', () => {
    it('should log and retrieve activities', () => {
      const project = db.createProject('p1');
      const agent = db.createAgent('bot1');
      const ticket = db.createTicket(project.id, 'Task');

      const activity = db.logActivity(agent.id, ticket.id, 'ticket_created', 'Created');
      expect(activity.action).toBe('ticket_created');
      expect(activity.agentId).toBe(agent.id);

      const activities = db.getActivitiesByProject(project.id);
      expect(activities).toHaveLength(1);
    });

    it('should log activity with null agentId', () => {
      const project = db.createProject('p1');
      const ticket = db.createTicket(project.id, 'Task');
      const activity = db.logActivity(null, ticket.id, 'ticket_moved', 'Human moved');
      expect(activity.agentId).toBeNull();
    });
  });

  describe('audit log', () => {
    it('should log and retrieve audit entries', () => {
      const agent = db.createAgent('bot1');

      const entry = db.logAudit(agent.id, 'POST', '/api/projects', 201, '{"name":"p1"}');
      expect(entry.method).toBe('POST');
      expect(entry.path).toBe('/api/projects');
      expect(entry.statusCode).toBe(201);

      const entries = db.getAllAuditEntries();
      expect(entries).toHaveLength(1);
    });

    it('should filter audit entries by agent', () => {
      const agent1 = db.createAgent('bot1');
      const agent2 = db.createAgent('bot2');

      db.logAudit(agent1.id, 'GET', '/api/projects', 200, '');
      db.logAudit(agent2.id, 'POST', '/api/projects', 201, '{}');
      db.logAudit(agent1.id, 'GET', '/api/agents', 200, '');

      const entries = db.getAuditEntriesByAgent(agent1.id);
      expect(entries).toHaveLength(2);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        db.logAudit(null, 'GET', '/api/test', 200, '');
      }
      const entries = db.getAllAuditEntries(5);
      expect(entries).toHaveLength(5);
    });
  });
});
