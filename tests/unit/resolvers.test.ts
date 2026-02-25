import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentboardDB } from '../../src/db/database.js';
import { createResolvers } from '../../src/graphql/resolvers.js';

describe('GraphQL Resolvers', () => {
  let db: AgentboardDB;
  let resolvers: Record<string, any>;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    resolvers = createResolvers(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Query', () => {
    it('should resolve projects', () => {
      db.createProject('p1');
      db.createProject('p2');
      const result = resolvers.Query.projects();
      expect(result).toHaveLength(2);
    });

    it('should resolve a single project by ID', () => {
      const project = db.createProject('p1');
      const result = resolvers.Query.project(null, { id: project.id });
      expect(result).toBeDefined();
      expect(result.name).toBe('p1');
    });

    it('should return undefined for nonexistent project', () => {
      const result = resolvers.Query.project(null, { id: 'nonexistent' });
      expect(result).toBeUndefined();
    });

    it('should resolve agents', () => {
      db.createAgent('bot1');
      db.createAgent('bot2');
      const result = resolvers.Query.agents();
      expect(result).toHaveLength(2);
    });
  });

  describe('Project', () => {
    it('should resolve tickets for project', () => {
      const project = db.createProject('p1');
      db.createTicket(project.id, 'T1');
      db.createTicket(project.id, 'T2');
      const result = resolvers.Project.tickets({ id: project.id });
      expect(result).toHaveLength(2);
    });
  });

  describe('Ticket', () => {
    it('should resolve agent when agentId is present', () => {
      const agent = db.createAgent('bot1');
      const result = resolvers.Ticket.agent({ agentId: agent.id });
      expect(result).toBeDefined();
      expect(result.name).toBe('bot1');
    });

    it('should return null when agentId is null', () => {
      const result = resolvers.Ticket.agent({ agentId: null });
      expect(result).toBeNull();
    });

    it('should return null when agentId is invalid', () => {
      const result = resolvers.Ticket.agent({ agentId: 'nonexistent' });
      expect(result).toBeNull();
    });

    it('should resolve comments for a ticket', () => {
      const project = db.createProject('p1');
      const agent = db.createAgent('bot1');
      const ticket = db.createTicket(project.id, 'T1');
      db.createComment(ticket.id, agent.id, 'Hello');
      const result = resolvers.Ticket.comments({ id: ticket.id });
      expect(result).toHaveLength(1);
    });
  });

  describe('Comment', () => {
    it('should resolve agent for a comment', () => {
      const agent = db.createAgent('bot1');
      const result = resolvers.Comment.agent({ agentId: agent.id });
      expect(result).toBeDefined();
      expect(result.name).toBe('bot1');
    });

    it('should return null for invalid agent', () => {
      const result = resolvers.Comment.agent({ agentId: 'nonexistent' });
      expect(result).toBeNull();
    });
  });

  describe('Activity', () => {
    it('should resolve agent for an activity', () => {
      const agent = db.createAgent('bot1');
      const result = resolvers.Activity.agent({ agentId: agent.id });
      expect(result).toBeDefined();
      expect(result.name).toBe('bot1');
    });

    it('should return null when agentId is null', () => {
      const result = resolvers.Activity.agent({ agentId: null });
      expect(result).toBeNull();
    });

    it('should return null for invalid agentId', () => {
      const result = resolvers.Activity.agent({ agentId: 'nonexistent' });
      expect(result).toBeNull();
    });
  });

  describe('Subscription', () => {
    it('should have ticketCreated subscription resolver', () => {
      expect(resolvers.Subscription.ticketCreated.subscribe).toBeDefined();
    });

    it('should have ticketUpdated subscription resolver', () => {
      expect(resolvers.Subscription.ticketUpdated.subscribe).toBeDefined();
    });

    it('should have ticketMoved subscription resolver', () => {
      expect(resolvers.Subscription.ticketMoved.subscribe).toBeDefined();
    });

    it('should have activityAdded subscription resolver', () => {
      expect(resolvers.Subscription.activityAdded.subscribe).toBeDefined();
    });
  });
});
