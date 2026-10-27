// Content script for github.com: adds "Ask Claude" to PR pages.
// - A floating ✦ button on the hovered diff line (needs line numbers in the DOM).
// - An "Ask Claude" pill on any text selection inside a diff (works on any layout).
// - A launcher button for questions about the whole PR.
// Everything lives in one shadow root so GitHub's CSS and React don't touch it.
(() => {
  if (window.__askClaudeLoaded) return;
  window.__askClaudeLoaded = true;

  const HUNK_BEFORE = 12;
  const HUNK_AFTER = 3;
  const MAX_HISTORY = 200;

  // ---------- PR detection ----------

  function currentPr() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) return null;
    const repo = `${m[1]}/${m[2]}`.toLowerCase();
    const pr = Number(m[3]);
    return { repo, pr, chatId: `${repo}#${pr}` };
  }

  // ---------- Diff context extraction ----------
  // Two layouts are supported:
  // - Classic (/files): td.blob-num[data-line-number] number cells (id ends in L<n>/R<n>),
  //   td.blob-code code cells, file path in data-tagsearch-path / data-path.
  // - New React view (/changes): td.diff-text-cell code cells that carry data-line-number and
  //   data-diff-side themselves, marker in .diff-text-marker, and table[aria-label="Diff for: <path>"].

  const PATH_ATTRS = ["data-tagsearch-path", "data-path", "data-file-path"];
  const PATH_SELECTOR = PATH_ATTRS.map((a) => `[${a}]`).join(",");
  const TABLE_LABEL = "Diff for: ";

  const pathAttr = (el) => PATH_ATTRS.map((a) => el.getAttribute(a)).find(Boolean) ?? null;

  /** File path for a node inside a diff, or null if it isn't in one. */
  function findPath(node) {
    const el = node instanceof Element ? node : node?.parentElement;
    if (!el) return null;
    const label = el.closest(`table[aria-label^="${TABLE_LABEL}"]`)?.getAttribute("aria-label");
    if (label) return label.slice(TABLE_LABEL.length);
    const holder = el.closest(PATH_SELECTOR);
    if (holder) return pathAttr(holder);
    // Otherwise find the nearest container whose path elements all name one file.
    for (let up = el.parentElement, depth = 0; up && depth < 12; up = up.parentElement, depth++) {
      const paths = new Set([...up.querySelectorAll(PATH_SELECTOR)].map(pathAttr).filter(Boolean));
      if (paths.size === 1) return [...paths][0];
      if (paths.size > 1) return null;
    }
    return null;
  }

  const isCodeCell = (td) => td?.tagName === "TD" && /\b(diff-text-cell|blob-code)\b/.test(td.className);
  const hasLineNumber = (td) => !!td.getAttribute?.("data-line-number");

  /** { code, line, side } for a code cell, or null if it has no line (an empty split-view half). */
  function cellLine(code) {
    let num = hasLineNumber(code) ? code : null;
    for (let td = code.previousElementSibling; !num && td && !isCodeCell(td); td = td.previousElementSibling) {
      if (hasLineNumber(td)) num = td;
    }
    if (!num) return null;
    const sideAttr = (code.getAttribute("data-diff-side") ?? num.getAttribute("data-diff-side") ?? "").toUpperCase();
    const side =
      sideAttr === "LEFT" || sideAttr === "RIGHT"
        ? sideAttr
        : /L\d+$/.test(num.id)
          ? "LEFT"
          : /R\d+$/.test(num.id)
            ? "RIGHT"
            : /deletion/.test(num.className + code.className)
              ? "LEFT"
              : "RIGHT";
    return { code, line: Number(num.getAttribute("data-line-number")), side };
  }

  /** The diff line under a hovered cell: its own code cell, or the code cell it numbers. */
  function lineAt(td) {
    const row = td?.closest("tr");
    if (!row) return null;
    if (isCodeCell(td)) return cellLine(td);
    for (let n = td.nextElementSibling; n; n = n.nextElementSibling) if (isCodeCell(n)) return cellLine(n);
    const codes = [...row.cells].filter(isCodeCell);
    return codes.length ? cellLine(codes.at(-1)) : null;
  }

  function markerOf(code) {
    const explicit = (
      code.querySelector("[data-code-marker]")?.getAttribute("data-code-marker") ??
      code.querySelector(".diff-text-marker")?.textContent ??
      ""
    ).trim();
    if (explicit) return explicit;
    const classes = code.className + " " + (code.querySelector("code")?.className ?? "");
    return /addition/.test(classes) ? "+" : /deletion/.test(classes) ? "-" : " ";
  }

  function formatLine({ code, line }) {
    const text = (code.querySelector(".blob-code-inner, .diff-text-inner") ?? code).textContent.replace(/\n$/, "");
    return `${markerOf(code)}${String(line).padStart(5)} | ${text}`;
  }

  /**
   * A row as unified-diff lines. Split-view rows hold two halves: keep the old side
   * only when it was deleted, so context lines aren't listed twice.
   */
  function rowLines(row) {
    const halves = [...row.cells].filter(isCodeCell).map(cellLine).filter(Boolean);
    if (halves.length < 2) return halves.map(formatLine);
    const left = halves.find((h) => h.side === "LEFT");
    const right = halves.find((h) => h.side === "RIGHT");
    return [left && markerOf(left.code) === "-" ? left : null, right ?? left].filter(Boolean).map(formatLine);
  }

  /** Surrounding lines from the same file's table. */
  function hunkAround(rowStart, rowEnd) {
    const rows = [...(rowStart.closest("table")?.rows ?? [])];
    const a = rows.indexOf(rowStart);
    const b = rows.indexOf(rowEnd);
    if (a === -1 || b === -1) return undefined;
    return rows
      .slice(Math.max(0, Math.min(a, b) - HUNK_BEFORE), Math.max(a, b) + HUNK_AFTER + 1)
      .flatMap(rowLines)
      .join("\n");
  }

  function contextForCell(td) {
    const info = lineAt(td);
    if (!info) return null;
    const path = findPath(info.code);
    if (!path) return null;
    const row = info.code.closest("tr");
    return { path, line_start: info.line, line_end: info.line, side: info.side, hunk: hunkAround(row, row) };
  }

  function contextForSelection(selection) {
    const range = selection.getRangeAt(0);
    const path = findPath(range.startContainer);
    if (!path || path !== findPath(range.endContainer)) return null;
    const start = lineAt(range.startContainer.parentElement?.closest("td"));
    const end = lineAt(range.endContainer.parentElement?.closest("td"));
    const ctx = { path, hunk: selection.toString().slice(0, 20_000) };
    if (start && end) {
      ctx.line_start = Math.min(start.line, end.line);
      ctx.line_end = Math.max(start.line, end.line);
      ctx.side = end.side;
    }
    return ctx;
  }

  function describeContext(ctx) {
    if (!ctx) return "";
    const lines = ctx.line_start
      ? ctx.line_end && ctx.line_end !== ctx.line_start
        ? `:${ctx.line_start}-${ctx.line_end}`
        : `:${ctx.line_start}`
      : "";
    return `${ctx.path}${lines}${ctx.side === "LEFT" ? " (old)" : ""}`;
  }

  // ---------- Markdown (escape first, then a small safe subset) ----------

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  function renderMarkdown(src) {
    const out = [];
    const lines = escapeHtml(src).split("\n");
    let para = [];
    let list = null;
    const flushPara = () => para.length && (out.push(`<p>${inline(para.join("<br>"))}</p>`), (para = []));
    const flushList = () => list && (out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`), (list = null));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s*```(.*)$/);
      if (fence) {
        flushPara();
        flushList();
        const body = [];
        while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i]);
        out.push(`<pre><code>${body.join("\n")}</code></pre>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (heading) {
        flushPara();
        flushList();
        out.push(`<h4>${inline(heading[2])}</h4>`);
      } else if (bullet || numbered) {
        flushPara();
        const tag = bullet ? "ul" : "ol";
        if (list?.tag !== tag) flushList();
        list ??= { tag, items: [] };
        list.items.push((bullet ?? numbered)[1]);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
    return out.join("");
  }

  // ---------- UI ----------

  const host = document.createElement("div");
  host.id = "ask-claude-root";
  host.style.cssText = "position:fixed;inset:0 auto auto 0;z-index:2147483000;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .ui { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
        --bg: var(--bgColor-default, #ffffff); --bg2: var(--bgColor-muted, #f6f8fa); --fg: var(--fgColor-default, #1f2328);
        --muted: var(--fgColor-muted, #59636e); --border: var(--borderColor-default, #d1d9e0); --accent: #d97757; color: var(--fg); }
      button { font: inherit; cursor: pointer; }
      .gutter { position: fixed; display: none; width: 22px; height: 20px; padding: 0; border-radius: 6px; border: 1px solid var(--accent);
        background: var(--accent); color: #fff; font-size: 12px; line-height: 18px; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
      .pill { position: fixed; display: none; padding: 3px 10px; border-radius: 999px; border: 0; background: var(--accent); color: #fff;
        font-size: 12px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
      .launcher { position: fixed; right: 20px; bottom: 20px; display: none; padding: 8px 14px; border-radius: 999px; border: 0;
        background: var(--accent); color: #fff; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
      .panel { position: fixed; right: 16px; bottom: 16px; width: min(440px, calc(100vw - 32px)); height: min(640px, calc(100vh - 96px));
        display: none; flex-direction: column; background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
        box-shadow: 0 12px 32px rgba(0,0,0,.25); overflow: hidden; }
      .panel.open { display: flex; }
      header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--bg2); }
      header .heading { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
      header .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      header .session { font-size: 11px; color: var(--muted); }
      .icon:disabled { opacity: .5; cursor: default; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #9198a1; flex: none; }
      .dot.ok { background: #1a7f37; } .dot.bad { background: #cf222e; }
      .icon { border: 0; background: transparent; color: var(--muted); padding: 2px 6px; border-radius: 6px; }
      .icon:hover { background: var(--border); color: var(--fg); }
      .banner { display: none; padding: 10px 12px; font-size: 13px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, #bf8700 12%, var(--bg)); }
      .banner.show { display: block; }
      .banner code { font-size: 11px; }
      .banner button { margin-top: 6px; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
      .messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
      .empty { color: var(--muted); font-size: 13px; text-align: center; margin: auto 12px; }
      .msg { max-width: 92%; padding: 8px 10px; border-radius: 10px; overflow-wrap: anywhere; }
      .msg.user { align-self: flex-end; background: color-mix(in srgb, var(--accent) 16%, var(--bg)); white-space: pre-wrap; }
      .msg.claude { align-self: flex-start; background: var(--bg2); border: 1px solid var(--border); }
      .msg.error { align-self: center; color: #cf222e; font-size: 12px; }
      .msg.pending { align-self: flex-start; color: var(--muted); font-style: italic; font-size: 13px; }
      .msg.streaming { opacity: .85; }
      .msg .status { display: block; margin-top: 4px; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; font-style: normal;
        color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ctx { display: block; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); margin-bottom: 4px; }
      .msg.claude p, .msg.claude ul, .msg.claude ol, .msg.claude pre, .msg.claude h4 { margin: 0 0 8px; } .msg.claude > :last-child { margin-bottom: 0; }
      .msg.claude ul, .msg.claude ol { padding-left: 20px; }
      .msg.claude h4 { font-size: 14px; }
      .msg.claude a { color: var(--fgColor-accent, #0969da); }
      code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: color-mix(in srgb, var(--muted) 15%, transparent); padding: 1px 4px; border-radius: 4px; }
      pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; overflow-x: auto; }
      pre code { background: none; padding: 0; }
      .copy { float: right; font-size: 11px; margin: -4px -6px 0 6px; }
      footer { border-top: 1px solid var(--border); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
      .chip { display: none; align-items: center; gap: 6px; align-self: flex-start; max-width: 100%; padding: 2px 4px 2px 8px; border-radius: 999px;
        border: 1px solid var(--border); font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
      .chip.show { display: inline-flex; } .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row { display: flex; gap: 6px; align-items: flex-end; }
      textarea { flex: 1; resize: none; min-height: 38px; max-height: 160px; font: inherit; color: var(--fg); background: var(--bg);
        border: 1px solid var(--border); border-radius: 8px; padding: 8px; outline: none; }
      textarea:focus { border-color: var(--accent); }
      .send { padding: 8px 12px; border-radius: 8px; border: 0; background: var(--accent); color: #fff; font-weight: 600; }
      .send:disabled { opacity: .5; cursor: default; }
    </style>
    <div class="ui">
      <button class="gutter" title="Ask Claude about this line">✦</button>
      <button class="pill">✦ Ask Claude</button>
      <button class="launcher">✦ Ask Claude</button>
      <section class="panel" role="dialog" aria-label="Ask Claude">
        <header>
          <span class="dot"></span>
          <span class="heading"><span class="title"></span><span class="session"></span></span>
          <button class="icon new-session" title="End this PR's Claude session and start a new one">New session</button>
          <button class="icon close" title="Close" aria-label="Close">✕</button>
        </header>
        <div class="banner"></div>
        <div class="messages"></div>
        <footer>
          <div class="chip"><span></span><button class="icon unchip" title="Remove context" aria-label="Remove context">✕</button></div>
          <div class="row">
            <textarea rows="1" placeholder="Ask about this PR…"></textarea>
            <button class="send">Send</button>
          </div>
        </footer>
      </section>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const ui = {
    gutter: $(".gutter"), pill: $(".pill"), launcher: $(".launcher"), panel: $(".panel"), title: $(".title"),
    dot: $(".dot"), banner: $(".banner"), messages: $(".messages"), chip: $(".chip"), chipText: $(".chip span"),
    input: $("textarea"), send: $(".send"),
  };

  // ---------- Chat state ----------
  // Each PR has a Claude Code session on the service that remembers the conversation
  // and resumes after restarts. The panel only keeps the messages for display.
  // "New session" ends that session and clears the panel.

  let pr = null; // { repo, pr, chatId }
  // Persisted per PR. `waiting` holds message ids of questions still being answered.
  let chat = emptyChat();
  // In memory: progress of waiting questions, keyed by message id (or a local id until acknowledged).
  const progress = new Map(); // id -> { status, partial }
  let pendingContext = null;
  let port = null;
  let askSeq = 0;
  const askCallbacks = new Map();

  function emptyChat() {
    return { messages: [], waiting: [], instance: null, lastEventId: 0 };
  }

  /**
   * False once the extension is reloaded or updated: this script keeps running in
   * already-open tabs, but every chrome.* call throws "Extension context invalidated".
   */
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  const storageKey = () => `chat:${pr.chatId}`;
  const save = () => {
    if (!alive()) return shutdown();
    try {
      chrome.storage.local.set({ [storageKey()]: { ...chat, messages: chat.messages.slice(-MAX_HISTORY) } }).catch(shutdown);
    } catch {
      shutdown();
    }
  };

  async function loadChat() {
    if (!alive()) return shutdown();
    let stored;
    try {
      stored = (await chrome.storage.local.get(storageKey()))[storageKey()];
    } catch {
      return shutdown();
    }
    chat = { ...emptyChat(), ...stored };
    progress.clear();
    for (const id of chat.waiting) progress.set(id, { status: "", partial: "" });
    renderMessages();
  }

  function addMessage(msg) {
    chat.messages.push({ ts: Date.now(), ...msg });
    save();
    renderMessages();
  }

  let resetCallback = null;

  async function newSession() {
    if (!pr) return;
    if (chat.messages.length && !confirm("Start a new session for this PR? Claude will forget this conversation.")) return;
    if (!port) connect();
    if (!port) return;
    const button = $(".new-session");
    button.disabled = true;
    const result = await new Promise((resolve) => {
      resetCallback = resolve;
      port.postMessage({ type: "reset" });
    });
    button.disabled = false;
    if (!result.ok) {
      addMessage({ role: "error", text: `Couldn't start a new session: ${result.error}` });
      return;
    }
    chat = { ...emptyChat(), instance: chat.instance, lastEventId: chat.lastEventId };
    progress.clear();
    early.clear();
    save();
    setSessionLabel(null);
    renderMessages();
    ui.input.focus();
  }

  /** Header note: whether the next question continues a saved session or starts one. */
  function setSessionLabel(session) {
    const label = $(".session");
    if (!session) {
      label.textContent = "new session";
      label.title = "The next question starts a new Claude session for this PR.";
      return;
    }
    const started = new Date(session.created);
    const sameDay = started.toDateString() === new Date().toDateString();
    const when = sameDay
      ? started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : started.toLocaleDateString([], { month: "short", day: "numeric" });
    label.textContent = `session since ${when}`;
    label.title = `Claude remembers this PR's conversation (session ${session.session_id}).`;
  }

  function renderClaude(el, text) {
    el.innerHTML = renderMarkdown(text);
  }

  function renderMessages() {
    ui.messages.replaceChildren();
    if (!chat.messages.length && !progress.size) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Ask about the PR, or hover a diff line and click ✦ (or select code) to ask about it.";
      ui.messages.append(empty);
    }
    for (const m of chat.messages) {
      const el = document.createElement("div");
      el.className = `msg ${m.role}`;
      if (m.role === "claude") {
        renderClaude(el, m.text);
        const copy = document.createElement("button");
        copy.className = "icon copy";
        copy.textContent = "Copy";
        copy.addEventListener("click", () => navigator.clipboard.writeText(m.text).then(() => (copy.textContent = "Copied")));
        el.prepend(copy);
      } else {
        if (m.context) {
          const ctx = document.createElement("span");
          ctx.className = "ctx";
          ctx.textContent = describeContext(m.context);
          el.append(ctx);
        }
        el.append(document.createTextNode(m.text));
      }
      ui.messages.append(el);
    }
    for (const p of progress.values()) {
      const el = document.createElement("div");
      if (p.partial) {
        el.className = "msg claude streaming";
        renderClaude(el, p.partial);
      } else {
        el.className = "msg pending";
        el.textContent = "Claude is thinking…";
      }
      if (p.status) {
        const status = document.createElement("span");
        status.className = "status";
        status.textContent = p.status;
        el.append(status);
      }
      ui.messages.append(el);
    }
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  // ---------- Connection to the background worker ----------

  function setStatus(msg) {
    const states = {
      ok: ["ok", null],
      reconnecting: ["", null],
      "no-token": ["bad", { text: "Set the pairing token in the extension settings.", button: "Open settings", action: "options" }],
      "bad-token": ["bad", {
        text: "The service rejected the pairing token. Copy the current one with:",
        code: "pbcopy < ~/.config/github-channel/token",
        button: "Open settings", action: "options",
      }],
      "no-service": ["bad", {
        text: "The Ask Claude service isn't running. Start it in github-channel/server:",
        code: "bun start",
        button: "Retry", action: "retry",
      }],
      "no-clone": ["bad", {
        text: `No local clone of ${pr.repo} was found under ~/projects. Clone it there, or map it in ~/.config/github-channel/repos.json:`,
        code: `{ "${pr.repo}": "/path/to/clone" }`,
        button: "Retry", action: "retry",
      }],
    };
    const [dot, banner] = states[msg.state] ?? ["", null];
    ui.dot.className = `dot ${dot}`;
    ui.dot.title = msg.state;
    ui.banner.classList.toggle("show", !!banner);
    if (banner) {
      ui.banner.replaceChildren(document.createTextNode(banner.text));
      if (banner.code) {
        const code = document.createElement("code");
        code.textContent = banner.code;
        ui.banner.append(document.createElement("br"), code);
      }
      const btn = document.createElement("button");
      btn.textContent = banner.button;
      btn.addEventListener("click", () =>
        banner.action === "options"
          ? alive() && chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {})
          : port?.postMessage({ type: "retry" }),
      );
      ui.banner.append(document.createElement("br"), btn);
    }
    if (msg.instance && msg.instance !== chat.instance) {
      // The service restarted: event ids start over, and answers in progress were lost.
      const lost = chat.waiting.length > 0 && chat.instance !== null;
      chat.instance = msg.instance;
      chat.lastEventId = 0;
      chat.waiting = [];
      progress.clear();
      save();
      if (lost) addMessage({ role: "error", text: "The service restarted before answering. Ask again." });
      else renderMessages();
    }
  }

  // Events that arrive before /ask's response tells us their message id.
  const early = new Map(); // message id -> events

  function onEvent({ event, instance }) {
    if (instance !== chat.instance || event.id <= chat.lastEventId) return;
    chat.lastEventId = event.id;
    const id = event.message_id;
    if (!chat.waiting.includes(id)) {
      if ([...progress.keys()].some((k) => k.startsWith("local-"))) {
        early.set(id, [...(early.get(id) ?? []), event]);
      }
      return save(); // Otherwise: cleared, or asked from another tab.
    }
    applyEvent(event);
  }

  function applyEvent(event) {
    const id = event.message_id;
    const p = progress.get(id) ?? { status: "", partial: "" };
    if (event.type === "status") p.status = event.text;
    else if (event.type === "partial") p.partial = event.text;
    if (event.type === "status" || event.type === "partial") {
      progress.set(id, p);
      renderMessages();
      return;
    }
    chat.waiting = chat.waiting.filter((w) => w !== id);
    progress.delete(id);
    if (event.type === "reply") {
      addMessage({ role: "claude", text: event.text });
      port?.postMessage({ type: "session-info" });
    }
    else if (event.type === "error") addMessage({ role: "error", text: `Claude couldn't answer: ${event.text}` });
  }

  function onPortMessage(msg) {
    if (msg.type === "status") {
      setStatus(msg);
      if (msg.state === "ok") setSessionLabel(msg.session);
    } else if (msg.type === "session-info") setSessionLabel(msg.session);
    else if (msg.type === "reset-result") {
      resetCallback?.(msg);
      resetCallback = null;
    } else if (msg.type === "event") onEvent(msg);
    else if (msg.type === "ask-result") {
      askCallbacks.get(msg.id)?.(msg);
      askCallbacks.delete(msg.id);
    }
  }

  let pingTimer = null;
  function connect() {
    disconnect();
    if (!alive()) return shutdown();
    port = chrome.runtime.connect({ name: "chat" });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // The service worker was stopped; reconnect while the panel is open.
      if (ui.panel.classList.contains("open") && pr) setTimeout(connect, 500);
    });
    port.postMessage({ type: "hello", repo: pr.repo, pr: pr.pr, chatId: pr.chatId, instance: chat.instance, lastEventId: chat.lastEventId });
    pingTimer = setInterval(() => port?.postMessage({ type: "ping" }), 20_000);
  }

  function disconnect() {
    clearInterval(pingTimer);
    if (port) {
      const p = port;
      port = null;
      p.disconnect();
    }
  }

  async function sendQuestion() {
    const question = ui.input.value.trim();
    if (!question || !pr) return;
    if (!alive()) return shutdown();
    if (!port) connect();
    if (!port) {
      addMessage({ role: "error", text: "The extension was updated or reloaded. Refresh this page." });
      return;
    }
    const context = pendingContext;
    ui.input.value = "";
    autosize();
    setContext(null);
    const seq = ++askSeq;
    const localId = `local-${seq}`;
    progress.set(localId, { status: "", partial: "" });
    addMessage({ role: "user", text: question, context });
    if (!port) return; // Shut down while saving.
    const result = await new Promise((resolve) => {
      askCallbacks.set(seq, resolve);
      port.postMessage({ type: "ask", id: seq, payload: { repo: pr.repo, pr: pr.pr, question, ...(context ?? {}) } });
    });
    const p = progress.get(localId);
    progress.delete(localId);
    if (!p) return; // Cleared while sending.
    if (!result.ok) {
      addMessage({ role: "error", text: `Not sent: ${result.error}` });
      return;
    }
    progress.set(result.messageId, p);
    chat.waiting.push(result.messageId);
    save();
    renderMessages();
    for (const event of early.get(result.messageId) ?? []) applyEvent(event);
    early.delete(result.messageId);
  }

  // ---------- Panel behavior ----------

  function openPanel() {
    ui.panel.classList.add("open");
    ui.launcher.style.display = "none";
    if (!port) connect();
    ui.input.focus();
  }

  function closePanel() {
    ui.panel.classList.remove("open");
    ui.launcher.style.display = pr ? "block" : "none";
    disconnect();
  }

  function setContext(ctx) {
    pendingContext = ctx;
    ui.chip.classList.toggle("show", !!ctx);
    ui.chipText.textContent = describeContext(ctx);
    ui.input.placeholder = ctx ? "Ask about this code…" : "Ask about this PR…";
  }

  function autosize() {
    ui.input.style.height = "auto";
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, 160)}px`;
  }

  ui.launcher.addEventListener("click", openPanel);
  $(".close").addEventListener("click", closePanel);
  $(".unchip").addEventListener("click", () => setContext(null));
  $(".new-session").addEventListener("click", newSession);
  ui.send.addEventListener("click", sendQuestion);
  ui.input.addEventListener("input", autosize);
  ui.input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // Keep GitHub's keyboard shortcuts out of the textarea.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendQuestion();
    }
  });

  // ---------- Gutter button and selection pill ----------

  let hoverCell = null;

  document.addEventListener(
    "mouseover",
    (e) => {
      if (!pr) return;
      const cell = e.target instanceof Element ? e.target.closest("td") : null;
      if (!cell || cell === hoverCell) return;
      const info = lineAt(cell);
      if (!info || !findPath(info.code)) return;
      hoverCell = cell;
      placeGutter(cell, info.code);
      // GitHub draws its own hover buttons a moment after the mouse arrives; move next to them once they exist.
      for (const ms of [50, 200]) setTimeout(() => hoverCell === cell && placeGutter(cell, info.code), ms);
    },
    { passive: true },
  );

  // GitHub's hover buttons on a line (comment, etc.) in the new view: a Primer ButtonGroup.
  const LINE_ACTIONS = '[class*="prc-ButtonGroup-ButtonGroup"], [class*="prc-ButtonGroup-Item"]';

  /** GitHub's visible button group on this row, if any (it may be rendered just outside the row). */
  function lineActionsFor(row) {
    const rowRect = row.getBoundingClientRect();
    const scope = row.closest("table")?.parentElement ?? row;
    for (const el of [...row.querySelectorAll(LINE_ACTIONS), ...scope.querySelectorAll(LINE_ACTIONS)]) {
      const group = el.closest('[class*="prc-ButtonGroup-ButtonGroup"]') ?? el;
      const r = group.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(group).visibility !== "hidden";
      if (visible && r.bottom > rowRect.top && r.top < rowRect.bottom) return r;
    }
    return null;
  }

  /** Puts ✦ just left of GitHub's line buttons, or at the right edge of the code cell. */
  function placeGutter(cell, codeCell) {
    const rowEl = cell.closest("tr");
    if (!rowEl) return;
    const row = rowEl.getBoundingClientRect();
    const actions = lineActionsFor(rowEl);
    if (actions) {
      ui.gutter.style.left = `${actions.left - 22 - 4}px`;
      ui.gutter.style.top = `${actions.top + (actions.height - 20) / 2}px`;
    } else {
      const code = codeCell.getBoundingClientRect();
      ui.gutter.style.left = `${Math.min(code.right, window.innerWidth) - 30}px`;
      ui.gutter.style.top = `${row.top + Math.max(0, (row.height - 20) / 2)}px`;
    }
    ui.gutter.style.display = "block";
  }

  const hideFloating = () => {
    ui.gutter.style.display = "none";
    ui.pill.style.display = "none";
    hoverCell = null;
  };
  window.addEventListener("scroll", hideFloating, { passive: true, capture: true });

  ui.gutter.addEventListener("click", () => {
    const ctx = hoverCell && contextForCell(hoverCell);
    hideFloating();
    if (!ctx) return;
    setContext(ctx);
    openPanel();
  });

  document.addEventListener("mouseup", (e) => {
    if (!pr || e.composedPath().includes(host)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim() || !findPath(sel.anchorNode)) {
        ui.pill.style.display = "none";
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      ui.pill.style.left = `${Math.min(rect.right, window.innerWidth - 120)}px`;
      ui.pill.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 32)}px`;
      ui.pill.style.display = "block";
    });
  });

  // mousedown would clear the selection before click fires.
  ui.pill.addEventListener("mousedown", (e) => e.preventDefault());
  ui.pill.addEventListener("click", () => {
    const sel = window.getSelection();
    const ctx = sel && !sel.isCollapsed ? contextForSelection(sel) : null;
    hideFloating();
    if (!ctx) return;
    setContext(ctx);
    openPanel();
  });

  // ---------- Page lifecycle (GitHub navigates without reloading) ----------

  async function onLocationChange() {
    const next = currentPr();
    if (next?.chatId === pr?.chatId) return;
    const wasOpen = ui.panel.classList.contains("open");
    disconnect();
    pr = next;
    hideFloating();
    setContext(null);
    if (!pr) {
      ui.panel.classList.remove("open");
      ui.launcher.style.display = "none";
      return;
    }
    ui.title.textContent = `Ask Claude · ${pr.chatId}`;
    await loadChat();
    if (wasOpen) openPanel();
    else ui.launcher.style.display = "block";
  }

  (document.body ?? document.documentElement).append(host);
  // GitHub replaces <body> children on some navigations; keep our host attached.
  const reattach = new MutationObserver(() => host.isConnected || document.body.append(host));
  reattach.observe(document.documentElement, { childList: true, subtree: false });
  const tick = () => (alive() ? onLocationChange() : shutdown());
  const navEvents = ["turbo:load", "pjax:end", "popstate"];
  for (const ev of navEvents) window.addEventListener(ev, tick);
  const locationTimer = setInterval(tick, 1000);
  tick();

  /**
   * Stops this orphaned copy: timers, listeners, and UI. If the panel is open, it stays
   * with a note to refresh (which loads the new version); otherwise everything is removed.
   */
  let shutDown = false;
  function shutdown() {
    if (shutDown) return;
    shutDown = true;
    clearInterval(locationTimer);
    for (const ev of navEvents) window.removeEventListener(ev, tick);
    reattach.disconnect();
    clearInterval(pingTimer);
    port = null;
    pr = null; // Every handler checks this and does nothing.
    hideFloating();
    ui.launcher.style.display = "none";
    if (!ui.panel.classList.contains("open")) return host.remove();
    ui.dot.className = "dot bad";
    ui.input.disabled = ui.send.disabled = true;
    const refresh = document.createElement("button");
    refresh.textContent = "Refresh page";
    refresh.addEventListener("click", () => location.reload());
    ui.banner.replaceChildren(document.createTextNode("The extension was updated. Refresh this page to keep asking."), document.createElement("br"), refresh);
    ui.banner.classList.add("show");
  }

  // Exposed for tests only.
  window.__askClaudeTest = { findPath, contextForCell, contextForSelection, renderMarkdown, describeContext };
})();
