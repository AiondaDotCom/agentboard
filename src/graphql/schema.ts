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

  type BoardColumn {
    id: String!
    title: String!
  }

  type Ticket {
    id: ID!
    projectId: String!
    title: String!
    description: String
    column: String!
    position: Int!
    group: String
    blockedReason: String
    priority: String!
    workType: String
    dependsOn: [String!]!
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
    columns: [BoardColumn!]!
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
    agentId: String
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

  type TicketAccessEvent {
    ticketId: ID!
    projectId: String!
    agentId: String!
    agentName: String!
    action: String!
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

  type RuntimeReport {
    host: String!
    workingCodex: Int!
    workingClaude: Int!
    workingOpenCode: Int!
    idleCodex: Int!
    idleClaude: Int!
    idleOpenCode: Int!
    reportedAt: String!
  }

  type RuntimeStatus {
    working: Int!
    idle: Int!
    codexWorking: Int!
    claudeWorking: Int!
    openCodeWorking: Int!
    workingSince: String
    workingForSeconds: Int!
    hosts: [RuntimeReport!]!
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
    commentAdded(projectId: ID!): Comment!
    agentChanged: Agent!
    projectChanged: Project!
    ticketAccessed(projectId: ID!): TicketAccessEvent!
    ticketViewed(projectId: ID!): TicketViewEvent!
    auditAdded: AuditEntry!
    runtimeStatusChanged: RuntimeStatus!
  }
`;
