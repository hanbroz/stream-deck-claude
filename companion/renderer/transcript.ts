import { parseMarkdown, type InlineNode, type MarkdownBlock } from "../shared/markdown";

export type TurnRole = "user" | "assistant" | "error";

/**
 * Builds the conversation DOM.
 *
 * Every piece of model output reaches the page through textContent, never
 * innerHTML, so markup inside a reply stays inert text.
 */
function appendInline(target: HTMLElement, nodes: readonly InlineNode[]): void {
  for (const node of nodes) {
    if (node.type === "text") {
      target.append(document.createTextNode(node.text));
      continue;
    }
    const tag = node.type === "bold" ? "strong" : node.type === "italic" ? "em" : "code";
    const element = document.createElement(tag);
    if (node.type === "code") {
      element.className = "md-code-inline";
    }
    element.textContent = node.text;
    target.append(element);
  }
}

function createCodeBlock(block: Extract<MarkdownBlock, { type: "code" }>): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "md-code-block";

  const header = document.createElement("div");
  header.className = "md-code-block__header";

  const language = document.createElement("span");
  language.className = "md-code-block__lang";
  language.textContent = block.language || "text";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "md-code-block__copy";
  copy.textContent = "복사";
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(block.code).then(
      () => {
        copy.textContent = "복사됨";
        setTimeout(() => { copy.textContent = "복사"; }, 1200);
      },
      () => { copy.textContent = "복사 실패"; }
    );
  });

  header.append(language, copy);

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = block.code;
  pre.append(code);

  wrapper.append(header, pre);
  return wrapper;
}

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (const block of parseMarkdown(source)) {
    if (block.type === "code") {
      fragment.append(createCodeBlock(block));
      continue;
    }
    if (block.type === "list") {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      list.className = "md-list";
      for (const item of block.items) {
        const li = document.createElement("li");
        appendInline(li, item);
        list.append(li);
      }
      fragment.append(list);
      continue;
    }
    if (block.type === "heading") {
      const heading = document.createElement(`h${Math.min(block.level, 6)}`);
      heading.className = "md-heading";
      appendInline(heading, block.inline);
      fragment.append(heading);
      continue;
    }
    if (block.type === "quote") {
      const quote = document.createElement("blockquote");
      quote.className = "md-quote";
      appendInline(quote, block.inline);
      fragment.append(quote);
      continue;
    }
    const paragraph = document.createElement("p");
    paragraph.className = "md-paragraph";
    appendInline(paragraph, block.inline);
    fragment.append(paragraph);
  }

  return fragment;
}

export type Turn = {
  role: TurnRole;
  text: string;
  element: HTMLElement;
  body: HTMLElement;
};

// Only the labelled roles; the user turn is set apart by its accent border and
// deliberately has no header, so it is not listed here.
const ROLE_LABELS: Record<Exclude<TurnRole, "user">, string> = {
  assistant: "Claude",
  error: "오류"
};

export function createTurn(role: TurnRole): Turn {
  const element = document.createElement("article");
  element.className = `turn turn--${role}`;

  const body = document.createElement("div");
  body.className = "turn__body";

  if (role === "user") {
    element.append(body);
  } else {
    const header = document.createElement("header");
    header.className = "turn__role";
    header.textContent = ROLE_LABELS[role];
    element.append(header, body);
  }
  return { role, text: "", element, body };
}

/**
 * User text is shown verbatim: it is what the person typed, and running their
 * own input through the Markdown parser would mangle literal asterisks.
 */
export function paintTurn(turn: Turn): void {
  turn.body.replaceChildren();
  if (turn.role === "assistant") {
    turn.body.append(renderMarkdown(turn.text));
    return;
  }
  const paragraph = document.createElement("p");
  paragraph.className = "md-paragraph";
  paragraph.textContent = turn.text;
  turn.body.append(paragraph);
}
