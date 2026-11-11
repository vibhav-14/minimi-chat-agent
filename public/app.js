// Wires the page together: the composer, the running turn, and scrolling.
import { ChatRequestError, streamChat } from './api.js';
import { AssistantMessage, userMessage } from './message-view.js';

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

prompt.focus();
