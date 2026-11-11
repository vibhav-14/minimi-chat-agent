import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AgentEvent } from './agent/events.js';
import { runTurn } from './agent/loop.js';
import type { Clock } from './clock.js';
import { isTimeZone } from './config.js';
import type { LlmProvider } from './llm/types.js';
import type { MemoryStore } from './memory/store.js';
import type { SearchProvider } from './search/types.js';

/** About 2,000 tokens: room for a pasted list or email, not a whole document. */
const MESSAGE_LIMIT = 8000;

export interface Providers {
  llm: LlmProvider;
  search: SearchProvider;
}

export interface AppDeps {
  /** Directory the browser UI is served from. */
  publicDir: string;
  store: MemoryStore;
  clock: Clock;
  /** Used when the browser sends no zone, or one this runtime does not know. */
  defaultTimeZone: string;
  /** The model and search providers, or why they could not be built (a missing key). */
  providers: Providers | { unavailable: string };
}

const chatRequestSchema = z.object({
  conversationId: z.string().min(1).optional(),
  message: z.string().trim().min(1).max(MESSAGE_LIMIT),
  timeZone: z.string().optional(),
});

/** Builds the HTTP app without listening, so tests can call it with app.request(). */
export function createApp(deps: AppDeps): Hono {
  const { publicDir, store, clock, defaultTimeZone, providers } = deps;
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  app.post('/api/chat', async (c) => {
    const parsed = chatRequestSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    }
    const { conversationId, message } = parsed.data;
    if (conversationId && !store.getConversation(conversationId)) {
      return c.json({ error: 'Conversation not found' }, 404);
    }
    const requested = parsed.data.timeZone;
    const timeZone =
      requested && isTimeZone(requested) ? requested : defaultTimeZone;

    return streamSSE(c, async (stream) => {
      const send = (event: AgentEvent) =>
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) });

      if ('unavailable' in providers) {
        await send({
          type: 'error',
          kind: 'config',
          message: providers.unavailable,
        });
        return;
      }

      // A closed tab stops the model and searches instead of paying for an unread answer.
      const controller = new AbortController();
      stream.onAbort(() =>
        controller.abort(new Error('The client disconnected.')),
      );
      try {
        const turn = runTurn(
          { ...providers, store, clock },
          { conversationId, message, timeZone, signal: controller.signal },
        );
        for await (const event of turn) await send(event);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Chat turn failed:', error);
        await send({
          type: 'error',
          kind: 'other',
          message: 'Something went wrong while answering. Please try again.',
        });
      }
    });
  });

  app.get('/api/conversations', (c) => c.json(store.listConversations()));

  app.get('/api/conversations/:id', (c) => {
    const conversation = store.getConversation(c.req.param('id'));
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404);
    return c.json({
      ...conversation,
      messages: store.getMessages(conversation.id),
    });
  });

  // A mistyped API path must fail as JSON, not return the UI page.
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  app.use('/*', serveStatic({ root: publicDir }));

  return app;
}
