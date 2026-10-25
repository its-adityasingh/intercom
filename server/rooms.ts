import { randomBytes } from "node:crypto";

export interface Participant {
  id: string; token: string; name: string; language: string; connected: boolean; sockets: Set<string>;
}
export interface Message {
  id: string; clientMsgId?: string; roomId: string; senderId: string; senderName: string; createdAt: number;
  kind: "voice" | "text"; language: string;
  transcript: string;
  transcriptionStatus: "processing" | "done" | "failed";
  deliveryStatus: "processing" | "delivered" | "failed";
  speechStatus: "off" | "pending" | "ready" | "failed";
  audioId?: string; voice?: string; durationMs?: number;
  errorCode?: string; errorMessage?: string; speechError?: string;
  provider?: "gnani" | "mock";
  timings: { sttMs?: number; ttsMs?: number; totalMs?: number };
  responses: { by: string; kind: "unclear" | "confirmed"; at: number }[];
}
export interface Room {
  code: string; createdAt: number; lastActive: number; spokenPlayback: boolean;
  participants: Map<string, Participant>; messages: Message[]; byClientId: Map<string, string>;
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
export const MAX_PARTICIPANTS = 2;

export class RoomError extends Error {
  constructor(public code: "not_found" | "full" | "forbidden" | "invalid", message: string) { super(message); }
}

export class RoomStore {
  rooms = new Map<string, Room>();

  private newCode(): string {
    for (;;) {
      const b = randomBytes(6);
      const code = Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join("");
      if (!this.rooms.has(code)) return code;
    }
  }
  private newParticipant(name: string, language: string): Participant {
    return { id: randomBytes(8).toString("hex"), token: randomBytes(24).toString("hex"), name, language, connected: false, sockets: new Set() };
  }

  create(name: string, language: string, spokenPlayback: boolean) {
    const room: Room = { code: this.newCode(), createdAt: Date.now(), lastActive: Date.now(), spokenPlayback, participants: new Map(), messages: [], byClientId: new Map() };
    const p = this.newParticipant(name, language);
    room.participants.set(p.id, p);
    this.rooms.set(room.code, room);
    return { room, participant: p };
  }

  join(code: string, name: string, language: string) {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) throw new RoomError("not_found", "No room with that code. Check the code and try again.");
    if (room.participants.size >= MAX_PARTICIPANTS) throw new RoomError("full", "This room already has two participants.");
    const p = this.newParticipant(name, language);
    room.participants.set(p.id, p);
    room.lastActive = Date.now();
    return { room, participant: p };
  }

  auth(code: string, participantId: string, token: string): { room: Room; participant: Participant } {
    const room = this.rooms.get((code ?? "").toUpperCase());
    const participant = room?.participants.get(participantId);
    if (!room || !participant || participant.token !== token) throw new RoomError("forbidden", "Not a member of this room.");
    return { room, participant };
  }

  leave(room: Room, participantId: string) {
    room.participants.delete(participantId);
    if (room.participants.size === 0) this.rooms.delete(room.code);
  }

  /** Idempotent: same clientMsgId returns the existing message unless it failed (then caller may retry). */
  beginMessage(room: Room, p: Participant, clientMsgId: string, kind: Message["kind"]) {
    const existingId = room.byClientId.get(`${p.id}:${clientMsgId}`);
    const existing = existingId ? room.messages.find((m) => m.id === existingId) : undefined;
    if (existing) return { message: existing, duplicate: existing.deliveryStatus !== "failed" };
    const message: Message = {
      id: randomBytes(8).toString("hex"), roomId: room.code, senderId: p.id, senderName: p.name,
      createdAt: Date.now(), kind, language: p.language, transcript: "",
      transcriptionStatus: "processing", deliveryStatus: "processing",
      speechStatus: "off", timings: [] as any, responses: [],
    };
    message.timings = {}; message.clientMsgId = clientMsgId;
    room.messages.push(message);
    room.byClientId.set(`${p.id}:${clientMsgId}`, message.id);
    room.lastActive = Date.now();
    return { message, duplicate: false };
  }

  publicParticipants(room: Room) {
    return [...room.participants.values()].map((p) => ({ id: p.id, name: p.name, language: p.language, connected: p.connected }));
  }

  sweep(maxIdleMs = 2 * 60 * 60 * 1000) {
    for (const [code, r] of this.rooms) if (Date.now() - r.lastActive > maxIdleMs) this.rooms.delete(code);
  }
}

/** Sliding-window limiter, per key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs = 60_000) {}
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr); return true;
  }
}
