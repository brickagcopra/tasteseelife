/**
 * Room-name helpers for the Socket.IO realtime layer.
 *
 * The gateway and the broadcaster both touch room names — keeping the
 * helpers in a leaf module (no DI, no Nest types) avoids the
 * gateway ↔ broadcaster import cycle that would otherwise form.
 *
 * Shape: `<kind>:<id>`. Colon-delimited so a future debug surface can
 * eyeball the join state. The `thread:` / `user:` prefixes are part
 * of the room-name contract — every emit path agrees on these.
 */

export function roomForThread(threadId: string): string {
  return `thread:${threadId}`;
}

export function roomForUser(userId: string): string {
  return `user:${userId}`;
}
