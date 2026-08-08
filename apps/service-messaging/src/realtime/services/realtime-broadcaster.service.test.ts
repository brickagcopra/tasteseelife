import { describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';

import { roomForThread, roomForUser } from '../realtime-rooms';
import type { RealtimeGateway } from '../realtime.gateway';
import { RealtimeBroadcaster } from './realtime-broadcaster.service';

interface ServerStub {
  server: Server;
  emit: ReturnType<typeof vi.fn>;
  to: ReturnType<typeof vi.fn>;
}

function makeServerStub(): ServerStub {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const server = { to } as unknown as Server;
  return { server, emit, to };
}

function makeGatewayStub(server: Server | undefined): RealtimeGateway {
  return { getServer: () => server } as unknown as RealtimeGateway;
}

describe('RealtimeBroadcaster', () => {
  it('emits to the thread room via server.to(...).emit(...)', () => {
    const { server, to, emit } = makeServerStub();
    const broadcaster = new RealtimeBroadcaster(makeGatewayStub(server));
    broadcaster.emitToThread('thr_1', 'message.created', { messageId: 'msg_1' });
    expect(to).toHaveBeenCalledWith('thread:thr_1');
    expect(emit).toHaveBeenCalledWith('message.created', { messageId: 'msg_1' });
  });

  it('emits to the user room via server.to(...).emit(...)', () => {
    const { server, to, emit } = makeServerStub();
    const broadcaster = new RealtimeBroadcaster(makeGatewayStub(server));
    broadcaster.emitToUser('usr_1', 'thread.updated', { threadId: 'thr_1' });
    expect(to).toHaveBeenCalledWith('user:usr_1');
    expect(emit).toHaveBeenCalledWith('thread.updated', { threadId: 'thr_1' });
  });

  it('throws when invoked before the underlying server is initialised', () => {
    const broadcaster = new RealtimeBroadcaster(makeGatewayStub(undefined));
    expect(() => broadcaster.emitToThread('thr_1', 'message.created', {})).toThrowError(
      /before the Socket\.IO server was initialised/,
    );
  });

  it('room helpers produce the documented string shape', () => {
    expect(roomForThread('thr_1')).toBe('thread:thr_1');
    expect(roomForUser('usr_1')).toBe('user:usr_1');
  });
});
