import { describe, it, expect } from 'vitest';
import { pubsub, EVENTS } from '../../src/graphql/pubsub.js';

describe('PubSub', () => {
  it('should have all event constants defined', () => {
    expect(EVENTS.TICKET_CREATED).toBe('TICKET_CREATED');
    expect(EVENTS.TICKET_UPDATED).toBe('TICKET_UPDATED');
    expect(EVENTS.TICKET_MOVED).toBe('TICKET_MOVED');
    expect(EVENTS.TICKET_DELETED).toBe('TICKET_DELETED');
    expect(EVENTS.ACTIVITY_ADDED).toBe('ACTIVITY_ADDED');
  });

  it('should deliver published events to subscribers', async () => {
    const iterator = pubsub.subscribe('TEST_EVENT');
    const payload = { test: 'data' };

    pubsub.publish('TEST_EVENT', payload);

    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual(payload);

    await iterator.return!();
  });

  it('should filter events with asyncIterableIterator', async () => {
    const iterator = pubsub.asyncIterableIterator(
      'FILTER_TEST',
      (payload) => (payload as { id: number }).id === 2,
    );

    pubsub.publish('FILTER_TEST', { id: 1 });
    pubsub.publish('FILTER_TEST', { id: 2 });

    const result = await iterator.next();
    expect(result.value).toEqual({ id: 2 });

    await iterator.return!();
  });

  it('should return all events when no filter provided', async () => {
    const iterator = pubsub.asyncIterableIterator('NO_FILTER_TEST');

    pubsub.publish('NO_FILTER_TEST', { data: 1 });

    const result = await iterator.next();
    expect(result.value).toEqual({ data: 1 });

    await iterator.return!();
  });
});
