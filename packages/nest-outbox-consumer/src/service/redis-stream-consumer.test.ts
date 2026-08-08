import { describe, expect, it, vi } from 'vitest';

import {
  ensureConsumerGroup,
  flattenXreadgroupResponse,
  type ConsumerRedisClient,
} from './redis-stream-consumer';

function buildFakeRedis(): {
  redis: ConsumerRedisClient;
  callCalls: Array<Array<string | number>>;
  setCallBehaviour: (fn: () => Promise<unknown>) => void;
} {
  let behaviour: () => Promise<unknown> = async () => undefined;
  const callCalls: Array<Array<string | number>> = [];
  const redis: ConsumerRedisClient = {
    call: vi.fn(async (...args: Array<string | number>) => {
      callCalls.push(args);
      return behaviour();
    }),
    xreadgroup: vi.fn(async () => []),
    xack: vi.fn(async () => 0),
    xautoclaim: vi.fn(async () => ['0-0', [], []]),
    xpending: vi.fn(async () => []),
  };
  return {
    redis,
    callCalls,
    setCallBehaviour: (fn) => {
      behaviour = fn;
    },
  };
}

describe('ensureConsumerGroup', () => {
  it('calls XGROUP CREATE with MKSTREAM for a fresh stream', async () => {
    const { redis, callCalls } = buildFakeRedis();
    await ensureConsumerGroup(redis, 'events:subscription.activated', 'svc-acc');
    expect(callCalls[0]).toEqual([
      'XGROUP',
      'CREATE',
      'events:subscription.activated',
      'svc-acc',
      '$',
      'MKSTREAM',
    ]);
  });

  it('swallows BUSYGROUP errors (group already exists)', async () => {
    const { redis, setCallBehaviour } = buildFakeRedis();
    setCallBehaviour(async () => {
      throw new Error('BUSYGROUP Consumer Group name already exists');
    });
    await expect(ensureConsumerGroup(redis, 'events:x', 'svc')).resolves.toBeUndefined();
  });

  it('rethrows non-BUSYGROUP errors so the scheduler can surface them', async () => {
    const { redis, setCallBehaviour } = buildFakeRedis();
    setCallBehaviour(async () => {
      throw new Error('ERR connection refused');
    });
    await expect(ensureConsumerGroup(redis, 'events:x', 'svc')).rejects.toThrow(
      /connection refused/,
    );
  });
});

describe('flattenXreadgroupResponse', () => {
  it('returns an empty array for an empty / null response', () => {
    expect(flattenXreadgroupResponse(null)).toEqual([]);
    expect(flattenXreadgroupResponse([])).toEqual([]);
  });

  it('flattens a single-stream single-entry response', () => {
    const raw = [
      [
        'events:subscription.activated',
        [['1715900000000-0', ['event_id', 'evt_1', 'event_name', 'subscription.activated']]],
      ],
    ];
    const out = flattenXreadgroupResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      streamKey: 'events:subscription.activated',
      streamId: '1715900000000-0',
      fields: ['event_id', 'evt_1', 'event_name', 'subscription.activated'],
    });
  });

  it('flattens multiple streams and multiple entries per stream', () => {
    const raw = [
      [
        'events:a',
        [
          ['1-0', ['k', 'v1']],
          ['2-0', ['k', 'v2']],
        ],
      ],
      ['events:b', [['1-0', ['k', 'v3']]]],
    ];
    const out = flattenXreadgroupResponse(raw);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.streamKey)).toEqual(['events:a', 'events:a', 'events:b']);
    expect(out.map((e) => e.streamId)).toEqual(['1-0', '2-0', '1-0']);
  });

  it('coerces Buffer-shaped fields to utf-8 strings', () => {
    const raw = [['events:a', [['1-0', [Buffer.from('event_id'), Buffer.from('evt_1')]]]]];
    const out = flattenXreadgroupResponse(raw);
    expect(out[0]?.fields).toEqual(['event_id', 'evt_1']);
  });

  it('skips malformed entries defensively', () => {
    const raw = [
      [
        'events:a',
        [
          'not-an-entry',
          [42, []], // streamId not a string
          ['1-0', 'not-an-array'], // fields not an array
          ['2-0', ['k', 'v']],
        ],
      ],
    ];
    const out = flattenXreadgroupResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.streamId).toBe('2-0');
  });
});
