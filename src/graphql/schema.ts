// ---------------------------------------------------------------------------
// Agentboard – GraphQL type definitions
// ---------------------------------------------------------------------------

import { gql } from 'graphql-tag';

export const typeDefs = gql`
  type Agent {
    id: ID!
    name: String!
    createdAt: String!
  }

  type Ticket {
    id: ID!
    projectId: String!
    title: String!
    description: String
    column: String!
    position: Int!
    agent: Agent
    agentId: String
    assignee: Agent
    assigneeId: String
    comments: [Comment!]!
    createdAt: String!
    updatedAt: String!
  }

  type Project {
    id: ID!
    name: String!
    description: String
    tickets: [Ticket!]!
    createdAt: String!
  }

  type Comment {
    id: ID!
    ticketId: String!
    agent: Agent
    body: String!
    createdAt: String!
  }

  type Activity {
    id: ID!
    agent: Agent
    ticketId: String
    action: String!
    details: String
    timestamp: String!
  }

  type TicketViewEvent {
    ticketId: ID!
    projectId: String!
    agentId: String!
    agentName: String!
  }

  type AuditEntry {
    id: ID!
    agentId: String
    method: String!
    path: String!
    statusCode: Int!
    requestBody: String
    timestamp: String!
  }

  type Query {
    projects: [Project!]!
    project(id: ID!): Project
    agents: [Agent!]!
  }

  type Subscription {
    ticketCreated(projectId: ID!): Ticket!
    ticketUpdated(projectId: ID!): Ticket!
    ticketMoved(projectId: ID!): Ticket!
    ticketDeleted(projectId: ID!): Ticket!
    activityAdded(projectId: ID!): Activity!
    agentChanged: Agent!
    projectChanged: Project!
    ticketViewed(projectId: ID!): TicketViewEvent!
    auditAdded: AuditEntry!
  }
`;
