// ---------------------------------------------------------------------------
// Agentboard – simple EventEmitter-based PubSub for GraphQL subscriptions
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const EVENTS = {
  TICKET_CREATED: 'TICKET_CREATED',
  TICKET_UPDATED: 'TICKET_UPDATED',
  TICKET_MOVED: 'TICKET_MOVED',
  TICKET_DELETED: 'TICKET_DELETED',
  ACTIVITY_ADDED: 'ACTIVITY_ADDED',
} as const;

export class PubSub {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  publish(event: string, payload: Record<string, unknown>): void {
    this.emitter.emit(event, payload);
  }

  subscribe(event: string): AsyncIterableIterator<Record<string, unknown>> {
    // Create an async iterator that yields events
    // Use a queue-based approach
    const emitter = this.emitter;
    const pullQueue: Array<(value: IteratorResult<Record<string, unknown>>) => void> = [];
    const pushQueue: Array<Record<string, unknown>> = [];
    let done = false;

    const handler = (payload: Record<string, unknown>): void => {
      const resolver = pullQueue.shift();
      if (resolver !== undefined) {
        resolver({ value: payload, done: false });
      } else {
        pushQueue.push(payload);
      }
    };

    emitter.on(event, handler);

    return {
      next(): Promise<IteratorResult<Record<string, unknown>>> {
        if (done) {
          return Promise.resolve({ value: undefined as unknown as Record<string, unknown>, done: true });
        }
        const value = pushQueue.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        return new Promise((resolve) => {
          pullQueue.push(resolve);
        });
      },
      return(): Promise<IteratorResult<Record<string, unknown>>> {
        done = true;
        emitter.off(event, handler);
        for (const resolve of pullQueue) {
          resolve({ value: undefined as unknown as Record<string, unknown>, done: true });
        }
        pullQueue.length = 0;
        pushQueue.length = 0;
        return Promise.resolve({ value: undefined as unknown as Record<string, unknown>, done: true });
      },
      throw(error: Error): Promise<IteratorResult<Record<string, unknown>>> {
        done = true;
        emitter.off(event, handler);
        return Promise.reject(error);
      },
      [Symbol.asyncIterator](): AsyncIterableIterator<Record<string, unknown>> {
        return this;
      },
    };
  }

  asyncIterableIterator(event: string, filterFn?: (payload: Record<string, unknown>) => boolean): AsyncIterableIterator<Record<string, unknown>> {
    const iterator = this.subscribe(event);
    if (filterFn === undefined) {
      return iterator;
    }
    // Wrap with filter
    return {
      async next(): Promise<IteratorResult<Record<string, unknown>>> {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const result = await iterator.next();
          if (result.done === true) return result;
          if (filterFn(result.value)) return result;
        }
      },
      return: iterator.return?.bind(iterator) as () => Promise<IteratorResult<Record<string, unknown>>>,
      throw: iterator.throw?.bind(iterator) as (error: Error) => Promise<IteratorResult<Record<string, unknown>>>,
      [Symbol.asyncIterator](): AsyncIterableIterator<Record<string, unknown>> {
        return this;
      },
    };
  }
}

export const pubsub = new PubSub();
