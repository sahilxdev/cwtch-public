export class RoomRegistry {
  constructor({ maxOccupants = 2, idleTtlMs = 6 * 60 * 60 * 1000 } = {}) {
    this.maxOccupants = maxOccupants;
    this.idleTtlMs = idleTtlMs;
    this.rooms = new Map();
  }

  join(roomId, clientId, connection, now = Date.now()) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { id: roomId, clients: new Map(), createdAt: now, touchedAt: now };
      this.rooms.set(roomId, room);
    }

    const previous = room.clients.get(clientId);
    if (!previous && room.clients.size >= this.maxOccupants) {
      return { ok: false, code: "ROOM_FULL", occupants: room.clients.size };
    }

    if (previous && previous !== connection) {
      try { previous.close(4009, "DUPLICATE_SESSION"); } catch {}
    }

    room.clients.set(clientId, connection);
    room.touchedAt = now;
    return {
      ok: true,
      replaced: Boolean(previous && previous !== connection),
      occupants: room.clients.size,
      createdAt: room.createdAt
    };
  }

  leave(roomId, clientId, connection, now = Date.now()) {
    const room = this.rooms.get(roomId);
    if (!room) return 0;
    if (room.clients.get(clientId) === connection) room.clients.delete(clientId);
    room.touchedAt = now;
    if (room.clients.size === 0) this.rooms.delete(roomId);
    return room.clients.size;
  }

  relay(roomId, senderId, serializedMessage, now = Date.now()) {
    const room = this.rooms.get(roomId);
    if (!room) return 0;
    room.touchedAt = now;
    let delivered = 0;
    for (const [clientId, client] of room.clients) {
      if (clientId === senderId || client.readyState !== 1) continue;
      try {
        client.send(serializedMessage);
        delivered += 1;
      } catch {
        room.clients.delete(clientId);
        try { client.terminate?.(); } catch {}
      }
    }
    return delivered;
  }

  occupants(roomId) {
    return this.rooms.get(roomId)?.clients.size ?? 0;
  }

  sweep(now = Date.now()) {
    const removed = [];
    for (const [roomId, room] of this.rooms) {
      if (room.clients.size === 0 || now - room.touchedAt > this.idleTtlMs) {
        for (const client of room.clients.values()) {
          try { client.close(4008, "ROOM_EXPIRED"); } catch {}
        }
        this.rooms.delete(roomId);
        removed.push(roomId);
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
