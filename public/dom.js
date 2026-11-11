// The one way the UI builds DOM: elements from properties and children.
// String children become text nodes, so text is never parsed as HTML.

/** @typedef {Node | string | null | undefined | false} Child */

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Partial<HTMLElementTagNameMap[K]>} [props]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  Object.assign(element, props);
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      element.append(child);
    }
  }
  return element;
}
