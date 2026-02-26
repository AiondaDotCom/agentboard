// ---------------------------------------------------------------------------
// Agentboard – GraphQL resolvers
// ---------------------------------------------------------------------------

import type { AgentboardDB } from '../db/database.js';
import { pubsub, EVENTS } from './pubsub.js';

interface SubscriptionArgs {
  projectId: string;
}

// Define resolver return type to satisfy strict TypeScript
export function createResolvers(db: AgentboardDB): Record<string, unknown> {
  return {
    Query: {
      projects: (): ReturnType<typeof db.getAllProjects> => db.getAllProjects(),
      project: (_: unknown, args: { id: string }): ReturnType<typeof db.getProject> => db.getProject(args.id),
      agents: (): ReturnType<typeof db.getAllAgents> => db.getAllAgents(),
    },
    Project: {
      tickets: (parent: { id: string }): ReturnType<typeof db.getTicketsByProject> => db.getTicketsByProject(parent.id),
    },
    Ticket: {
      agent: (parent: { agentId: string | null }): ReturnType<typeof db.getAgentById> | null => {
        if (parent.agentId === null) return null;
        return db.getAgentById(parent.agentId) ?? null;
      },
      comments: (parent: { id: string }): ReturnType<typeof db.getCommentsByTicket> => db.getCommentsByTicket(parent.id),
    },
    Comment: {
      agent: (parent: { agentId: string }): ReturnType<typeof db.getAgentById> | null => {
        return db.getAgentById(parent.agentId) ?? null;
      },
    },
    Activity: {
      agent: (parent: { agentId: string | null }): ReturnType<typeof db.getAgentById> | null => {
        if (parent.agentId === null) return null;
        return db.getAgentById(parent.agentId) ?? null;
      },
    },
    Subscription: {
      ticketCreated: {
        subscribe: (_: unknown, args: SubscriptionArgs): AsyncIterableIterator<Record<string, unknown>> =>
          pubsub.asyncIterableIterator(EVENTS.TICKET_CREATED, (payload) => (payload as { projectId: string }).projectId === args.projectId),
      },
      ticketUpdated: {
        subscribe: (_: unknown, args: SubscriptionArgs): AsyncIterableIterator<Record<string, unknown>> =>
          pubsub.asyncIterableIterator(EVENTS.TICKET_UPDATED, (payload) => (payload as { projectId: string }).projectId === args.projectId),
      },
      ticketMoved: {
        subscribe: (_: unknown, args: SubscriptionArgs): AsyncIterableIterator<Record<string, unknown>> =>
          pubsub.asyncIterableIterator(EVENTS.TICKET_MOVED, (payload) => (payload as { projectId: string }).projectId === args.projectId),
      },
      ticketDeleted: {
        subscribe: (_: unknown, args: SubscriptionArgs): AsyncIterableIterator<Record<string, unknown>> =>
          pubsub.asyncIterableIterator(EVENTS.TICKET_DELETED, (payload) => (payload as { projectId: string }).projectId === args.projectId),
      },
      activityAdded: {
        subscribe: (_: unknown, args: SubscriptionArgs): AsyncIterableIterator<Record<string, unknown>> =>
          pubsub.asyncIterableIterator(EVENTS.ACTIVITY_ADDED, (payload) => (payload as { projectId: string }).projectId === args.projectId),
      },
      agentChanged: {
        subscribe: (): AsyncIterableIterator<Record<string, unknown>> =>
          pubsub.asyncIterableIterator(EVENTS.AGENT_CHANGED),
      },
      projectChanged: {
        subscribe: (): AsyncIterableIterator<Record<string, unknown>> =>
          pubsub.asyncIterableIterator(EVENTS.PROJECT_CHANGED),
      },
      ticketViewed: {
        subscribe: (_: unknown, args: SubscriptionArgs): AsyncIterableIterator<Record<string, unknown>> =>
          pubsub.asyncIterableIterator(EVENTS.TICKET_VIEWED, (payload) => (payload as { projectId: string }).projectId === args.projectId),
      },
    },
  };
}
