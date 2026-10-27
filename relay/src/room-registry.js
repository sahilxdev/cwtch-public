import { timingSafeEqual } from 'node:crypto';
export class RoomRegistry {
  constructor({ maxOccupants = 2, idleTtlMs = 21600000 } = {}) {
    this.maxOccupants = maxOccupants;
    this.idleTtlMs = idleTtlMs;
    this.rooms = new Map();
  }
  join(roomId, clientId, connection, now = Date.now(), auth = '') {
    let room = this.rooms.get(roomId);
    if (
      room &&
      (room.auth.length !== auth.length ||
        !timingSafeEqual(Buffer.from(room.auth), Buffer.from(auth)))
    )
      return { ok: false, code: 'AUTH_FAILED' };
    if (!room) {
      room = { id: roomId, auth, clients: new Map(), createdAt: now, touchedAt: now };
      this.rooms.set(roomId, room);
    }
    const previous = room.clients.get(clientId);
    if (!previous && room.clients.size >= this.maxOccupants)
      return { ok: false, code: 'ROOM_FULL' };
    room.clients.set(clientId, connection);
    room.touchedAt = now;
    if (previous && previous !== connection) {
      try {
        previous.close(4009, 'DUPLICATE_SESSION');
      } catch {}
    }
    return {
      ok: true,
      replaced: Boolean(previous && previous !== connection),
      ...this.membership(roomId),
    };
  }
  isCurrent(roomId, clientId, connection) {
    return this.rooms.get(roomId)?.clients.get(clientId) === connection;
  }
  touch(roomId, now = Date.now()) {
    const room = this.rooms.get(roomId);
    if (room) room.touchedAt = now;
  }
  membership(roomId) {
    const members = [...(this.rooms.get(roomId)?.clients.keys() || [])];
    return { occupants: members.length, members, leaderId: members[0] || null };
  }
  leave(roomId, clientId, connection, now = Date.now()) {
    const room = this.rooms.get(roomId);
    if (!room || room.clients.get(clientId) !== connection) return false;
    room.clients.delete(clientId);
    room.touchedAt = now;
    if (!room.clients.size) this.rooms.delete(roomId);
    return true;
  }
  relay(roomId, senderId, serializedMessage, now = Date.now()) {
    const room = this.rooms.get(roomId);
    if (!room) return 0;
    room.touchedAt = now;
    let delivered = 0;
    for (const [id, client] of room.clients) {
      if (id === senderId || client.readyState !== 1) continue;
      if (client.bufferedAmount > 262144) {
        client.close(4010, 'SLOW_CLIENT');
        continue;
      }
      try {
        client.send(serializedMessage);
        delivered++;
      } catch {
        client.terminate?.();
      }
    }
    return delivered;
  }
  occupants(roomId) {
    return this.membership(roomId).occupants;
  }
  sweep(now = Date.now()) {
    const removed = [];
    for (const [id, room] of this.rooms) {
      if (now - room.touchedAt > this.idleTtlMs) {
        this.rooms.delete(id);
        for (const client of room.clients.values()) {
          try {
            client.close(4008, 'ROOM_EXPIRED');
          } catch {}
        }
        removed.push(id);
      }
    }
    return removed;
  }
  stats() {
    let connections = 0;
    for (const room of this.rooms.values()) connections += room.clients.size;
    return { rooms: this.rooms.size, connections };
  }
}
