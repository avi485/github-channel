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

  const PATH_ATTRS = ["data-tagsearch-path", "data-path", "data-file-path"];

  /** File path for a node inside a diff, or null if it isn't in one. */
  function findPath(node) {
    let el = node instanceof Element ? node : node?.parentElement;
    if (!el) return null;
    const selector = PATH_ATTRS.map((a) => `[${a}]`).join(",");
    const holder = el.closest(selector);
    if (holder) return PATH_ATTRS.map((a) => holder.getAttribute(a)).find(Boolean);
    // Otherwise look for a file container whose subtree holds exactly one path.
    for (let up = el.parentElement, depth = 0; up && depth < 12; up = up.parentElement, depth++) {
      const found = up.querySelectorAll(selector);
      if (found.length === 1) return PATH_ATTRS.map((a) => found[0].getAttribute(a)).find(Boolean);
      if (found.length > 1) return null;
    }
    return null;
  }

  const isNumberCell = (td) => td?.hasAttribute?.("data-line-number") && td.getAttribute("data-line-number") !== "";

  function sideOf(numberCell) {
    const id = numberCell.id ?? "";
    if (/L\d+$/.test(id)) return "LEFT";
    if (/R\d+$/.test(id)) return "RIGHT";
    return /deletion/.test(numberCell.className) ? "LEFT" : "RIGHT";
  }

  /** The line-number cell that a hovered cell belongs to (handles unified and split rows). */
  function numberCellFor(cell) {
    if (isNumberCell(cell)) return cell;
    const row = cell.closest("tr");
    if (!row) return null;
    let last = null;
    for (const td of row.cells) {
      if (td === cell) break;
      if (isNumberCell(td)) last = td;
    }
    return last ?? [...row.cells].find(isNumberCell) ?? null;
  }

  /** The code cell for a number cell: the next cell that isn't a number cell. */
  function codeCellFor(numberCell) {
    for (let td = numberCell.nextElementSibling; td; td = td.nextElementSibling) {
      if (!td.hasAttribute("data-line-number") && !/blob-num/.test(td.className)) return td;
    }
    return null;
  }

  function lineText(row, side) {
    const cells = [...row.cells].filter(isNumberCell);
    const num = cells.find((c) => sideOf(c) === side) ?? cells.at(-1);
    if (!num) return null;
    const code = codeCellFor(num);
    if (!code) return null;
    const marker =
      code.querySelector("[data-code-marker]")?.getAttribute("data-code-marker") ??
      (/addition/.test(code.className) ? "+" : /deletion/.test(code.className) ? "-" : " ");
    const text = (code.querySelector(".blob-code-inner") ?? code).textContent.replace(/\n$/, "");
    return `${marker || " "}${num.getAttribute("data-line-number").padStart(5)} | ${text}`;
  }

  /** Surrounding lines from the same table, numbered on the given side. */
  function hunkAround(rowStart, rowEnd, side) {
    const rows = [...(rowStart.closest("tbody, table")?.rows ?? [])];
    const a = rows.indexOf(rowStart);
    const b = rows.indexOf(rowEnd);
    if (a === -1 || b === -1) return undefined;
    return rows
      .slice(Math.max(0, a - HUNK_BEFORE), b + HUNK_AFTER + 1)
      .map((r) => lineText(r, side))
      .filter(Boolean)
      .join("\n");
  }

  function contextForCell(cell) {
    const num = numberCellFor(cell);
    if (!num) return null;
    const path = findPath(num);
    if (!path) return null;
    const line = Number(num.getAttribute("data-line-number"));
    const side = sideOf(num);
    const row = num.closest("tr");
    return { path, line_start: line, line_end: line, side, hunk: hunkAround(row, row, side) };
  }

  function contextForSelection(selection) {
    const range = selection.getRangeAt(0);
    const path = findPath(range.startContainer);
    if (!path || path !== findPath(range.endContainer)) return null;
    const startCell = range.startContainer.parentElement?.closest("td");
    const endCell = range.endContainer.parentElement?.closest("td");
    const startNum = startCell && numberCellFor(startCell);
    const endNum = endCell && numberCellFor(endCell);
    const ctx = { path, hunk: selection.toString().slice(0, 20_000) };
    if (startNum && endNum) {
      const lines = [Number(startNum.getAttribute("data-line-number")), Number(endNum.getAttribute("data-line-number"))];
      ctx.line_start = Math.min(...lines);
      ctx.line_end = Math.max(...lines);
      ctx.side = sideOf(endNum);
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
      header .title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
          <span class="dot"></span><span class="title"></span>
          <button class="icon clear" title="Clear this chat">Clear</button>
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

  let pr = null; // { repo, pr, chatId }
  let chat = { messages: [], instance: null, lastEventId: 0 };
  let pendingContext = null;
  let pending = 0; // questions waiting for an answer
  let port = null;
  let askSeq = 0;
  const askCallbacks = new Map();

  const storageKey = () => `chat:${pr.chatId}`;
  const save = () => chrome.storage.local.set({ [storageKey()]: { ...chat, messages: chat.messages.slice(-MAX_HISTORY) } });

  async function loadChat() {
    chat = (await chrome.storage.local.get(storageKey()))[storageKey()] ?? { messages: [], instance: null, lastEventId: 0 };
    renderMessages();
  }

  function addMessage(msg) {
    chat.messages.push({ ts: Date.now(), ...msg });
    save();
    renderMessages();
  }

  function renderMessages() {
    ui.messages.replaceChildren();
    if (!chat.messages.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Ask about the PR, or hover a diff line and click ✦ (or select code) to ask about it.";
      ui.messages.append(empty);
    }
    for (const m of chat.messages) {
      const el = document.createElement("div");
      el.className = `msg ${m.role}`;
      if (m.role === "claude") {
        const copy = document.createElement("button");
        copy.className = "icon copy";
        copy.textContent = "Copy";
        copy.addEventListener("click", () => navigator.clipboard.writeText(m.text).then(() => (copy.textContent = "Copied")));
        el.innerHTML = renderMarkdown(m.text);
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
    if (pending > 0) {
      const el = document.createElement("div");
      el.className = "msg pending";
      el.textContent = "Claude is thinking…";
      ui.messages.append(el);
    }
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  // ---------- Connection to the background worker ----------

  function setStatus(msg) {
    const states = {
      connected: ["ok", null],
      reconnecting: ["", null],
      "no-token": ["bad", { text: "Set the pairing token in the extension settings.", button: "Open settings", action: "options" }],
      "bad-token": ["bad", { text: "The session rejected the pairing token. Paste the current one from `bun run token`.", button: "Open settings", action: "options" }],
      "no-session": ["bad", {
        text: `No Claude session found for ${pr.repo}. Start one in your clone:`,
        code: "claude --dangerously-load-development-channels server:github-channel",
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
        banner.action === "options" ? chrome.runtime.sendMessage({ type: "open-options" }) : port?.postMessage({ type: "retry" }),
      );
      ui.banner.append(document.createElement("br"), btn);
    }
    if (msg.state === "connected" && msg.instance !== chat.instance) {
      chat.instance = msg.instance;
      chat.lastEventId = 0;
      save();
    }
  }

  function onPortMessage(msg) {
    if (msg.type === "status") setStatus(msg);
    else if (msg.type === "reply") {
      const { event } = msg;
      if (msg.instance !== chat.instance || event.id <= chat.lastEventId) return;
      chat.lastEventId = event.id;
      pending = Math.max(0, pending - 1);
      addMessage({ role: "claude", text: event.text });
    } else if (msg.type === "ask-result") {
      askCallbacks.get(msg.id)?.(msg);
      askCallbacks.delete(msg.id);
    }
  }

  let pingTimer = null;
  function connect() {
    disconnect();
    if (!chrome.runtime?.id) return; // Extension was reloaded; this page's script is orphaned.
    port = chrome.runtime.connect({ name: "chat" });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // The service worker was stopped; reconnect while the panel is open.
      if (ui.panel.classList.contains("open") && pr) setTimeout(connect, 500);
    });
    port.postMessage({ type: "hello", repo: pr.repo, chatId: pr.chatId, instance: chat.instance, lastEventId: chat.lastEventId });
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
    if (!port) connect();
    if (!port) {
      addMessage({ role: "error", text: "The extension was updated or reloaded. Refresh this page." });
      return;
    }
    const context = pendingContext;
    ui.input.value = "";
    autosize();
    setContext(null);
    addMessage({ role: "user", text: question, context });
    pending++;
    renderMessages();
    const id = ++askSeq;
    const result = await new Promise((resolve) => {
      askCallbacks.set(id, resolve);
      port.postMessage({ type: "ask", id, payload: { repo: pr.repo, pr: pr.pr, question, ...(context ?? {}) } });
    });
    if (!result.ok) {
      pending = Math.max(0, pending - 1);
      addMessage({ role: "error", text: `Not sent: ${result.error}` });
    }
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
  $(".clear").addEventListener("click", () => {
    chat.messages = [];
    save();
    renderMessages();
  });
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
      const num = numberCellFor(cell);
      if (!num || !findPath(num)) return;
      hoverCell = cell;
      const row = cell.closest("tr").getBoundingClientRect();
      const code = codeCellFor(num)?.getBoundingClientRect() ?? row;
      ui.gutter.style.left = `${Math.min(code.right, window.innerWidth) - 30}px`;
      ui.gutter.style.top = `${row.top + Math.max(0, (row.height - 20) / 2)}px`;
      ui.gutter.style.display = "block";
    },
    { passive: true },
  );

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
    pending = 0;
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
  new MutationObserver(() => host.isConnected || document.body.append(host)).observe(document.documentElement, { childList: true, subtree: false });
  for (const ev of ["turbo:load", "pjax:end", "popstate"]) window.addEventListener(ev, onLocationChange);
  setInterval(onLocationChange, 1000);
  onLocationChange();

  // Exposed for tests only.
  window.__askClaudeTest = { findPath, contextForCell, contextForSelection, renderMarkdown, describeContext };
})();
