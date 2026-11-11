// The server's JSON shapes, for type checking the browser code. They mirror
// src/agent/events.ts and src/search/sources.ts; the browser cannot import
// TypeScript, so a change there must be copied here.

/**
 * @typedef {object} Source
 * @property {number} n
 * @property {string} url
 * @property {string} title
 * @property {string} [publishedDate]
 * @property {string} [snippet]
 */

/**
 * @typedef {{ query: string, status: 'ok', sources: number[] }
 *   | { query: string, status: 'failed', kind: string, message: string }} QueryReport
 */

/**
 * @typedef {{ type: 'start', conversationId: string, messageId: string }
 *   | { type: 'recall', dates: { text: string, days: string[] }[], exchanges: number, misses: string[] }
 *   | { type: 'search_started', callId: string, queries: string[], since?: string }
 *   | { type: 'search_finished', callId: string, queries: QueryReport[], sourcesAdded: Source[] }
 *   | { type: 'token', text: string }
 *   | { type: 'sources', sources: Source[] }
 *   | { type: 'done', messageId: string }
 *   | { type: 'error', kind: string, message: string }} AgentEvent
 */

export {};
