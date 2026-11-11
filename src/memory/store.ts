import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { Clock } from '../clock.js';
import type { Source } from '../search/sources.js';
import { bm25, terms } from './rank.js';
import type { DateRange } from './temporal.js';

export type Role = 'user' | 'assistant';

export type { Source };

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: Date;
  /** The user's IANA zone when the message was written. */
  timeZone: string;
  /** Sources the answer cited; always empty for user messages. */
  sources: Source[];
}

export interface NewMessage {
  conversationId: string;
  role: Role;
  content: string;
  timeZone: string;
  sources?: Source[];
  /** Defaults to the clock. Set it to import or seed earlier history. */
  createdAt?: Date;
}

/** A user message and the assistant message that answered it, if one was stored. */
export interface Exchange {
  question: Message;
  answer: Message | null;
}

type Row = Record<string, SQLOutputValue>;

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- seq orders messages written in the same millisecond.
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    time_zone TEXT NOT NULL,
    sources TEXT
  );
  CREATE INDEX messages_by_time ON messages (created_at);
  CREATE INDEX messages_by_conversation ON messages (conversation_id, created_at);
`;

const MESSAGE_COLUMNS = [
  'id',
  'conversation_id',
  'role',
  'content',
  'created_at',
  'time_zone',
  'sources',
];

// An exchange is a user message joined to the message right after it in the
// same conversation, when that message is the assistant's.
const EXCHANGES = `
  SELECT ${MESSAGE_COLUMNS.map((c) => `q.${c} AS q_${c}, a.${c} AS a_${c}`).join(', ')}
  FROM messages q
  LEFT JOIN messages a
    ON a.role = 'assistant'
    AND a.seq = (
      SELECT n.seq FROM messages n
      WHERE n.conversation_id = q.conversation_id
        AND (n.created_at, n.seq) > (q.created_at, q.seq)
      ORDER BY n.created_at, n.seq
      LIMIT 1
    )
  WHERE q.role = 'user'
`;

/** Conversations and messages in SQLite, with ranked search over content. */
export class MemoryStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
    private readonly statements: Statements,
  ) {}

  /** Opens or creates a store at `path`, or an in-memory one at `:memory:`. */
  static open(path: string, clock: Clock): MemoryStore {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return new MemoryStore(db, clock, prepareStatements(db));
  }

  createConversation(
    title: string,
    createdAt = this.clock.now(),
  ): Conversation {
    const conversation = { id: randomUUID(), title, createdAt };
    this.statements.insertConversation.run(
      conversation.id,
      title,
      createdAt.getTime(),
    );
    return conversation;
  }

  appendMessage(input: NewMessage): Message {
    const message: Message = {
      id: randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      createdAt: input.createdAt ?? this.clock.now(),
      timeZone: input.timeZone,
      sources: input.role === 'assistant' ? (input.sources ?? []) : [],
    };
    this.statements.insertMessage.run(
      message.id,
      message.conversationId,
      message.role,
      message.content,
      message.createdAt.getTime(),
      message.timeZone,
      message.role === 'assistant' ? JSON.stringify(message.sources) : null,
    );
    return message;
  }

  /** Newest first. */
  listConversations(): Conversation[] {
    return this.statements.conversations.all().map((row) => ({
      id: text(row.id),
      title: text(row.title),
      createdAt: new Date(Number(row.created_at)),
    }));
  }

  /** Oldest first. */
  getMessages(conversationId: string): Message[] {
    return this.statements.messages
      .all(conversationId)
      .map((row) => toMessage(row, ''));
  }

  /** Exchanges whose question was asked in `range`, oldest first. */
  exchangesBetween(range: DateRange): Exchange[] {
    return this.statements.exchangesBetween
      .all({ from: range.from.getTime(), to: range.to.getTime() })
      .map(toExchange);
  }

  /**
   * Exchanges whose question or answer shares words with `query`, best match
   * first. Any text is safe: only its words are used, never its punctuation.
   * An exchange scores as its best-scoring message.
   *
   * Every message is read and ranked on each call. One person's chat history
   * is thousands of messages at most; 5,000 take about a tenth of a second,
   * small beside the model call that follows.
   */
  searchExchanges(query: string, limit: number): Exchange[] {
    const queryTerms = terms(query);
    if (queryTerms.length === 0) return [];
    const rows = this.statements.searchable.all();
    const scores = bm25(
      queryTerms,
      rows.map((row) => terms(text(row.content))),
    );

    const best = new Map<number, number>();
    rows.forEach((row, i) => {
      const score = scores[i] ?? 0;
      const question = questionSeq(row, rows[i - 1]);
      if (question !== null && score > (best.get(question) ?? 0)) {
        best.set(question, score);
      }
    });
    return [...best]
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .flatMap(([seq]) => this.statements.exchangeBySeq.all(seq))
      .map(toExchange);
  }

  /** The `limit` exchanges asked closest in time to `instant`, closest first. */
  nearestExchanges(instant: Date, limit: number): Exchange[] {
    return this.statements.nearest
      .all({ at: instant.getTime(), limit })
      .map(toExchange);
  }

  close(): void {
    this.db.close();
  }
}

type Statements = ReturnType<typeof prepareStatements>;

function prepareStatements(db: DatabaseSync) {
  return {
    insertConversation: db.prepare(
      'INSERT INTO conversations (id, title, created_at) VALUES (?, ?, ?)',
    ),
    insertMessage: db.prepare(
      `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')}) VALUES (${MESSAGE_COLUMNS.map(() => '?').join(', ')})`,
    ),
    conversations: db.prepare(
      'SELECT * FROM conversations ORDER BY created_at DESC',
    ),
    messages: db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, seq',
    ),
    exchangesBetween: db.prepare(
      `${EXCHANGES} AND q.created_at >= :from AND q.created_at < :to ORDER BY q.created_at, q.seq`,
    ),
    exchangeBySeq: db.prepare(`${EXCHANGES} AND q.seq = ?`),
    nearest: db.prepare(
      `${EXCHANGES} ORDER BY abs(q.created_at - :at), q.seq LIMIT :limit`,
    ),
    // Ordered so a message's predecessor in its conversation is the row before it.
    searchable: db.prepare(
      'SELECT seq, conversation_id, role, content FROM messages ORDER BY conversation_id, created_at, seq',
    ),
  };
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get();
  const version = Number(row?.user_version ?? 0);
  if (version === SCHEMA_VERSION) return;
  if (version !== 0) {
    throw new Error(
      `Memory database has schema version ${version}; this build supports ${SCHEMA_VERSION}.`,
    );
  }
  db.exec('BEGIN');
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.exec('COMMIT');
}

/**
 * The question of the exchange a message belongs to: a user message is its own
 * question; an answer belongs to the user message right before it.
 */
function questionSeq(row: Row, previous: Row | undefined): number | null {
  if (row.role === 'user') return Number(row.seq);
  const answers =
    previous?.role === 'user' &&
    previous.conversation_id === row.conversation_id;
  return answers ? Number(previous.seq) : null;
}

function toExchange(row: Row): Exchange {
  return {
    question: toMessage(row, 'q_'),
    answer: row.a_id === null ? null : toMessage(row, 'a_'),
  };
}

function toMessage(row: Row, prefix: string): Message {
  const column = (name: string) => row[prefix + name] ?? null;
  const sources = column('sources');
  return {
    id: text(column('id')),
    conversationId: text(column('conversation_id')),
    role: text(column('role')) === 'assistant' ? 'assistant' : 'user',
    content: text(column('content')),
    createdAt: new Date(Number(column('created_at'))),
    timeZone: text(column('time_zone')),
    // Written by appendMessage from a Source[], so the shape is known.
    sources: sources === null ? [] : (JSON.parse(text(sources)) as Source[]),
  };
}

function text(value: SQLOutputValue | undefined): string {
  return typeof value === 'string' ? value : String(value);
}
