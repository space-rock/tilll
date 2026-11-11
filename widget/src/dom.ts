export type Child = Node | string | null | false | undefined;

type Props = {
  class?: string;
  text?: string;
  [attribute: string]: string | boolean | number | ((event: Event) => void) | undefined;
};

/**
 * Build an element. Text always goes in as a text node, never as HTML, so merchant-supplied text such as an
 * invoice description cannot inject markup. Props starting with `on` are event listeners.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (name === "class") el.className = String(value);
    else if (name === "text") el.textContent = String(value);
    else if (name.startsWith("on") && typeof value === "function")
      el.addEventListener(name.slice(2).toLowerCase(), value);
    else el.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

/** Copy text to the clipboard. Falls back to a hidden textarea where the async API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { style: "position:fixed;opacity:0", readonly: true });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } finally {
      area.remove();
    }
  }
}
