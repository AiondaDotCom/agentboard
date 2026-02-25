import { describe, it, expect } from 'vitest';
import { typeDefs } from '../../src/graphql/schema.js';

describe('GraphQL Schema', () => {
  it('should export typeDefs', () => {
    expect(typeDefs).toBeDefined();
  });

  it('should include Query type', () => {
    const source = (typeDefs as any).loc?.source?.body ?? '';
    expect(source).toContain('type Query');
  });

  it('should include Subscription type', () => {
    const source = (typeDefs as any).loc?.source?.body ?? '';
    expect(source).toContain('type Subscription');
  });

  it('should include Project type', () => {
    const source = (typeDefs as any).loc?.source?.body ?? '';
    expect(source).toContain('type Project');
  });

  it('should include Ticket type', () => {
    const source = (typeDefs as any).loc?.source?.body ?? '';
    expect(source).toContain('type Ticket');
  });
});
