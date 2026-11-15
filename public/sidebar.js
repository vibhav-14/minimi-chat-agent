// The conversation list. Each entry is a plain link to #<id>, so opening a
// conversation is ordinary navigation and app.js only follows the hash. On
// narrow screens the list sits behind the Chats button.
import { el } from './dom.js';
import { formatDate } from './format.js';

/** @typedef {import('./types.js').Conversation} Conversation */

const NARROW = window.matchMedia('(max-width: 760px)');

/**
 * @param {{ sidebar: HTMLElement, list: HTMLUListElement, menuButton: HTMLButtonElement, backdrop: HTMLElement }} parts
 */
export function createSidebar({ sidebar, list, menuButton, backdrop }) {
  let open = false;

  /** @param {boolean} value */
  function setOpen(value) {
    open = value;
    sidebar.classList.toggle('open', open);
    menuButton.ariaExpanded = String(open);
    backdrop.hidden = !open;
    // A closed drawer is off screen, so Tab must not reach into it.
    sidebar.inert = NARROW.matches && !open;
  }

  menuButton.addEventListener('click', () => {
    setOpen(!open);
    if (open) sidebar.querySelector('button')?.focus();
  });
  backdrop.addEventListener('click', () => setOpen(false));
  sidebar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      setOpen(false);
      menuButton.focus();
    }
  });
  // Choosing a conversation or a new chat closes the drawer.
  sidebar.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a, button')) {
      setOpen(false);
    }
  });
  NARROW.addEventListener('change', () => setOpen(false));
  setOpen(false);

  return {
    /**
     * @param {Conversation[]} conversations Newest first.
     * @param {string | undefined} currentId
     */
    render(conversations, currentId) {
      list.replaceChildren(
        ...conversations.map((conversation) => {
          const createdAt = new Date(conversation.createdAt);
          const link = el(
            'a',
            { className: 'conversation', href: `#${conversation.id}` },
            el('span', { className: 'conversation-title' }, conversation.title),
            el(
              'time',
              {
                className: 'conversation-date',
                dateTime: createdAt.toISOString(),
              },
              formatDate(createdAt),
            ),
          );
          if (conversation.id === currentId) link.ariaCurrent = 'page';
          return el('li', {}, link);
        }),
      );
    },
  };
}
