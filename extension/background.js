// Service worker: owns all traffic to 127.0.0.1 (content scripts can't reach it
// from github.com), and relays it to chat panels over runtime ports.
import { ask, findSession, listSessions, streamReplies } from "./bridge.js";

const getToken = async () => (await chrome.storage.local.get("token")).token ?? "";

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "open-options") {
    chrome.runtime.openOptionsPage();
  } else if (msg?.type === "list-sessions") {
    getToken().then((token) => listSessions(token)).then(sendResponse);
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "chat") new ChatConnection(port);
});

/** One per open chat panel: finds the PR's session and streams its replies. */
class ChatConnection {
  constructor(port) {
    this.port = port;
    this.session = null;
    this.abort = new AbortController();
    this.lastEventId = 0;
    port.onMessage.addListener((msg) => this.onMessage(msg));
    port.onDisconnect.addListener(() => this.abort.abort());
  }

  post(msg) {
    try {
      this.port.postMessage(msg);
    } catch {
      this.abort.abort();
    }
  }

  async onMessage(msg) {
    if (msg.type === "hello") {
      this.repo = msg.repo;
      this.chatId = msg.chatId;
      this.instance = msg.instance;
      this.lastEventId = msg.lastEventId ?? 0;
      this.run();
    } else if (msg.type === "retry") {
      this.wake?.();
    } else if (msg.type === "ask") {
      try {
        if (!this.session) throw new Error("No Claude session is connected for this repo.");
        const result = await ask(this.session.port, await getToken(), msg.payload);
        this.post({ type: "ask-result", id: msg.id, ok: true, messageId: result.message_id });
      } catch (err) {
        this.post({ type: "ask-result", id: msg.id, ok: false, error: String(err.message ?? err) });
      }
    }
    // "ping" messages only keep this worker alive.
  }

  /** Waits up to ms, or until the panel asks to retry. */
  sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => (clearTimeout(t), resolve());
    });
  }

  async run() {
    const { signal } = this.abort;
    while (!signal.aborted) {
      const token = await getToken();
      if (!token) {
        this.post({ type: "status", state: "no-token" });
        await this.sleep(5000);
        continue;
      }
      const session = await findSession(this.repo, token);
      if (!session || session.unauthorized) {
        this.session = null;
        this.post({ type: "status", state: session?.unauthorized ? "bad-token" : "no-session" });
        await this.sleep(5000);
        continue;
      }
      this.session = session;
      if (session.instance !== this.instance) {
        // A new server process numbers replies from 1 again.
        this.instance = session.instance;
        this.lastEventId = 0;
      }
      this.post({ type: "status", state: "connected", port: session.port, instance: session.instance });
      try {
        await streamReplies({
          port: session.port,
          token,
          chatId: this.chatId,
          lastEventId: this.lastEventId,
          signal,
          onEvent: (event) => {
            this.lastEventId = Math.max(this.lastEventId, event.id);
            this.post({ type: "reply", event, instance: this.instance });
          },
        });
      } catch {
        // Session ended or network error: fall through and rediscover.
      }
      this.session = null;
      if (!signal.aborted) {
        this.post({ type: "status", state: "reconnecting" });
        await this.sleep(1000);
      }
    }
  }
}
