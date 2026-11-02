// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  BaseSessionService,
  type CreateSessionRequest,
  type DeleteSessionRequest,
  type Event,
  type GetSessionRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type Session,
} from '@google/adk';

type Key = `${string}\u0000${string}\u0000${string}`;

function keyOf(appName: string, userId: string, sessionId: string): Key {
  return `${appName}\u0000${userId}\u0000${sessionId}`;
}

/**
 * The event log for ADK conversations, held in memory for the life of one prepared agent.
 * ADK's own in-memory service also shares `app:` and `user:` state between sessions; this one
 * keeps every key inside its conversation, so no state crosses a session boundary (ADR-0020).
 */
export class GalaxieSessionService extends BaseSessionService {
  readonly #sessions = new Map<Key, Session>();

  override async createSession(request: CreateSessionRequest): Promise<Session> {
    const id = request.sessionId?.trim();
    if (id === undefined || id.length === 0) throw new Error('A session ID is required.');
    const session: Session = {
      id,
      appName: request.appName,
      userId: request.userId,
      state: structuredClone(request.state ?? {}),
      events: [],
      lastUpdateTime: Date.now(),
    };
    this.#sessions.set(keyOf(request.appName, request.userId, id), session);
    return structuredClone(session);
  }

  override async getSession(request: GetSessionRequest): Promise<Session | undefined> {
    const session = this.#sessions.get(keyOf(request.appName, request.userId, request.sessionId));
    return session === undefined ? undefined : structuredClone(session);
  }

  override async listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sessions = [...this.#sessions.values()]
      .filter(
        (session) =>
          session.appName === request.appName &&
          (request.userId === undefined || session.userId === request.userId),
      )
      .map((session) => ({ ...session, state: {}, events: [] }));
    return {
      sessions,
      page: 1,
      limit: sessions.length,
      totalItems: sessions.length,
      totalPages: 1,
    };
  }

  override async deleteSession(request: DeleteSessionRequest): Promise<void> {
    this.#sessions.delete(keyOf(request.appName, request.userId, request.sessionId));
  }

  override async appendEvent(request: { session: Session; event: Event }): Promise<Event> {
    const event = await super.appendEvent(request);
    const { session } = request;
    session.lastUpdateTime = event.timestamp;
    const stored = this.#sessions.get(keyOf(session.appName, session.userId, session.id));
    if (stored !== undefined && !event.partial) {
      await super.appendEvent({ session: stored, event: structuredClone(event) });
      stored.lastUpdateTime = event.timestamp;
    }
    return event;
  }

  /** Forgets every conversation; used when the prepared agent is disposed. */
  clear(): void {
    this.#sessions.clear();
  }
}
