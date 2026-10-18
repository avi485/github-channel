// Service worker: owns all traffic to 127.0.0.1 (content scripts can't reach it
// from github.com), and relays it to chat panels over runtime ports.
import { ask, getStatus, streamEvents } from "./bridge.js";

const getToken = async () => (await chrome.storage.local.get("token")).token ?? "";

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "open-options") {
    chrome.runtime.openOptionsPage();
  } else if (msg?.type === "service-status") {
    getToken().then((token) => getStatus(token)).then(sendResponse);
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "chat") new ChatConnection(port);
});

/** One per open chat panel: checks the service and streams the PR chat's events. */
class ChatConnection {
  constructor(port) {
    this.port = port;
    this.status = null;
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
        if (this.status?.state !== "ok") throw new Error("The service isn't reachable. Check the banner above.");
        const result = await ask(this.status.port, await getToken(), msg.payload);
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
      this.status = token ? await getStatus(token, this.repo) : { state: "no-token" };
      this.post({ type: "status", state: this.status.state, instance: this.status.instance });
      if (this.status.state === "no-service" || this.status.state === "no-token" || this.status.state === "bad-token") {
        await this.sleep(5000);
        continue;
      }
      if (this.status.instance !== this.instance) {
        // A restarted service numbers events from 1 again.
        this.instance = this.status.instance;
        this.lastEventId = 0;
      }
      try {
        await streamEvents({
          port: this.status.port,
          token,
          chatId: this.chatId,
          lastEventId: this.lastEventId,
          signal,
          onEvent: (event) => {
            this.lastEventId = Math.max(this.lastEventId, event.id);
            this.post({ type: "event", event, instance: this.instance });
          },
        });
      } catch {
        // Service stopped or network error: fall through and check again.
      }
      if (!signal.aborted) {
        this.post({ type: "status", state: "reconnecting" });
        await this.sleep(1000);
      }
    }
  }
}
