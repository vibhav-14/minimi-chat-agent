// Wires the page together: the composer, the running turn, the open
// conversation (kept in the URL hash), and scrolling.
import {
  ChatRequestError,
  getConversation,
  listConversations,
  streamChat,
} from './api.js';
import { el } from './dom.js';
import {
  AssistantMessage,
  storedMessage,
  userMessage,
} from './message-view.js';
import { createSidebar } from './sidebar.js';

/** @typedef {import('./types.js').AgentEvent} AgentEvent */

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function byId(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing #${id}`);
  return element;
}

const scroller = byId('scroller', HTMLDivElement);
const thread = byId('thread', HTMLDivElement);
const composer = byId('composer', HTMLFormElement);
const prompt = byId('prompt', HTMLTextAreaElement);
const sendButton = byId('send', HTMLButtonElement);
const sidebar = createSidebar({
  sidebar: byId('sidebar', HTMLElement),
  list: byId('conversation-list', HTMLUListElement),
  menuButton: byId('menu-button', HTMLButtonElement),
  backdrop: byId('backdrop', HTMLDivElement),
});

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Pixels from the bottom that still count as "at the bottom". */
const STICK_DISTANCE = 48;

/** @type {string | undefined} */
let conversationId;
/** @type {AbortController | null} The running turn, or null when idle. */
let running = null;
// New text keeps the view at the bottom unless the reader scrolled up.
let stickToBottom = true;

scroller.addEventListener('scroll', () => {
  const distance =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  stickToBottom = distance < STICK_DISTANCE;
});

function followOutput() {
  if (stickToBottom) scroller.scrollTop = scroller.scrollHeight;
}

/** The textarea grows with its content, up to the cap set in CSS. */
function resizePrompt() {
  prompt.style.height = 'auto';
  prompt.style.height = `${prompt.scrollHeight}px`;
}

prompt.addEventListener('input', resizePrompt);

prompt.addEventListener('keydown', (event) => {
  // isComposing: Enter that confirms an IME candidate must not send.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    // While a turn runs, Enter must not reach the Stop button.
    if (!running) composer.requestSubmit();
  }
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (running) {
    running.abort();
    return;
  }
  const message = prompt.value.trim();
  if (message) void send(message);
});

/** @param {boolean} isRunning */
function setRunning(isRunning) {
  sendButton.textContent = isRunning ? 'Stop' : 'Send';
  sendButton.classList.toggle('stop', isRunning);
}

/** @param {string} message */
async function send(message) {
  const now = new Date();
  const view = new AssistantMessage(now, followOutput);
  thread.append(userMessage(message, now), view.element);
  view.wait('Thinking');
  prompt.value = '';
  resizePrompt();
  stickToBottom = true;
  followOutput();

  const controller = new AbortController();
  running = controller;
  setRunning(true);
  let ended = false;
  try {
    const body = { conversationId, message, timeZone };
    await streamChat(body, controller.signal, (event) => {
      if (handleEvent(event, view)) ended = true;
    });
    if (!ended) view.stop('The answer stopped before it finished.');
  } catch (error) {
    if (controller.signal.aborted) view.stop('Stopped.');
    else if (error instanceof ChatRequestError)
      view.fail('request', error.message);
    else view.stop('The connection was lost before the answer finished.');
  } finally {
    running = null;
    setRunning(false);
    prompt.focus();
    void refreshConversations();
  }
}

/**
 * Applies one event of the running turn to its view.
 *
 * @param {AgentEvent} event
 * @param {AssistantMessage} view
 * @returns {boolean} Whether the event ends the turn.
 */
function handleEvent(event, view) {
  switch (event.type) {
    case 'start':
      conversationId = event.conversationId;
      // Replace, not push: a new chat getting its id is not a navigation.
      history.replaceState(null, '', `#${conversationId}`);
      return false;
    case 'recall':
      view.recall(event);
      return false;
    case 'search_started':
      view.searchStarted(event);
      return false;
    case 'search_finished':
      view.searchFinished(event);
      return false;
    case 'token':
      view.appendText(event.text);
      return false;
    case 'sources':
      view.setSources(event.sources);
      return false;
    case 'done':
      view.finish();
      return true;
    case 'error':
      view.fail(event.kind, event.message);
      return true;
    default:
      return false;
  }
}

/** @type {import('./types.js').Conversation[]} */
let conversations = [];

async function refreshConversations() {
  try {
    conversations = await listConversations();
  } catch (error) {
    console.error('Could not load conversations:', error);
  }
  sidebar.render(conversations, conversationId);
}

/** Leaving a conversation stops its running turn; the question stays stored. */
function leaveConversation() {
  running?.abort();
  thread.replaceChildren();
  stickToBottom = true;
}

function startNewChat() {
  leaveConversation();
  conversationId = undefined;
  sidebar.render(conversations, conversationId);
  prompt.focus();
}

// Several opens can overlap (fast clicks); only the latest one renders.
let openRequest = 0;

/** @param {string} id */
async function openConversation(id) {
  leaveConversation();
  conversationId = id;
  sidebar.render(conversations, conversationId);
  const request = ++openRequest;
  let conversation;
  try {
    conversation = await getConversation(id);
  } catch (error) {
    console.error('Could not load the conversation:', error);
    if (request === openRequest)
      showNotice('This conversation could not be loaded.');
    return;
  }
  if (request !== openRequest) return;
  if (!conversation) {
    conversationId = undefined;
    history.replaceState(null, '', location.pathname);
    sidebar.render(conversations, conversationId);
    showNotice('That conversation does not exist. This is a new chat.');
    return;
  }
  thread.replaceChildren(...conversation.messages.map(storedMessage));
  followOutput();
}

/** @param {string} text */
function showNotice(text) {
  thread.replaceChildren(el('p', { className: 'notice stopped' }, text));
}

/** The hash names the open conversation; an empty hash is a new chat. */
function followHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id === (conversationId ?? '')) return;
  if (id) void openConversation(id);
  else startNewChat();
}

byId('new-chat', HTMLButtonElement).addEventListener('click', () => {
  // Clearing the hash with pushState fires no hashchange, so start directly.
  history.pushState(null, '', location.pathname);
  startNewChat();
});
window.addEventListener('hashchange', followHash);

followHash();
void refreshConversations();
prompt.focus();
