// -----------------------------------------------------------------------------
// Mopidy's native API, served by its HTTP frontend (Mopidy-HTTP, port 6680):
//
//   - JSON-RPC 2.0 over `POST /mopidy/rpc`: `core.playback.play`,
//     `core.mixer.set_volume`... A batch (an array of requests) is answered
//     in one round trip, each answer carrying the id of its request. The
//     request needs `Content-Type: application/json` (415 otherwise: the
//     CSRF protection of Mopidy). There is no authentication.
//   - the event WebSocket `/mopidy/ws`: `playback_state_changed`,
//     `track_playback_started`, `volume_changed`, `mute_changed`,
//     `tracklist_changed`, `options_changed`, `playlists_loaded`...
//     Each message is one JSON object with an `event` key.
//
// Checked on Mopidy 3.4.2 (Debian) and 4.0.5 (PyPI), see test/fixtures/mopidy/.
// Written from the documentation (https://docs.mopidy.com/stable/api/http/);
// no code was copied from a client library.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

/** Why a request failed, as the rest of the integration needs to know it. */
export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // refused, timed out, unknown host, connection lost
  NOT_MOPIDY: 'not_mopidy', // something answers, but not Mopidy's JSON-RPC
  FORBIDDEN: 'forbidden', // HTTP 401/403: a proxy in front of Mopidy refuses
  COMMAND: 'command', // Mopidy answered with a JSON-RPC error
});

export class MopidyError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message
   * @param {{ code?: number, method?: string }} [details]
   */
  constructor(kind, message, { code, method } = {}) {
    super(message);
    this.name = 'MopidyError';
    this.kind = kind;
    this.code = code;
    this.method = method;
  }
}

export const CLIENT_TIMINGS = {
  // A request (or a batch). Adding a web radio makes Mopidy read the stream
  // first (its `stream/timeout`, 5 s by default): leave room for it.
  requestMs: 15_000,
  // Opening the event WebSocket.
  socketOpenMs: 5_000,
};

// Largest answer accepted: protects the 256 MB of the container from a
// library listing gone wild or a peer that is not Mopidy.
const MAX_ANSWER_BYTES = 5_000_000;

/**
 * The base URL of a server.
 * @param {{ host: string, port: number, secure?: boolean }} server
 * @param {'http'|'ws'} scheme
 */
export function serverUrl({ host, port, secure = false }, scheme = 'http') {
  const name = host.includes(':') ? `[${host}]` : host;
  return `${scheme}${secure ? 's' : ''}://${name}:${port}`;
}

export class MopidyClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {{ host: string, port: number, secure?: boolean }} options.server
   * @param {object} [options.timings] CLIENT_TIMINGS overrides
   * @param {typeof fetch} [options.fetch] seam
   * @param {typeof WebSocket} [options.WebSocket] seam
   */
  constructor({ server, timings, fetch, WebSocket }) {
    super();
    this.rpcUrl = `${serverUrl(server)}/mopidy/rpc`;
    this.wsUrl = `${serverUrl(server, 'ws')}/mopidy/ws`;
    this.timings = { ...CLIENT_TIMINGS, ...timings };
    this.fetch = fetch ?? globalThis.fetch;
    this.WebSocketClass = WebSocket ?? globalThis.WebSocket;
    this.nextId = 1;
    this.socket = null;
    this.closed = false;
  }

  // --- JSON-RPC ----------------------------------------------------------------

  /**
   * Call one method.
   * @param {string} method e.g. `core.playback.play`
   * @param {object} [params] named parameters
   */
  async call(method, params) {
    const [answer] = await this.batch([[method, params]]);
    return answer;
  }

  /**
   * Call several methods in one round trip. Mopidy runs them in order.
   * Rejects with the first JSON-RPC error (the other calls did run).
   * @param {Array<[string, object?]>} calls
   * @returns {Promise<any[]>} the results, in the order of the calls
   */
  async batch(calls) {
    const requests = calls.map(([method, params]) => ({
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      ...(params === undefined ? {} : { params }),
    }));
    const body = await this.post(requests.length === 1 ? requests[0] : requests);
    const answers = Array.isArray(body) ? body : [body];
    const byId = new Map(
      answers.filter((answer) => answer && typeof answer === 'object').map((a) => [a.id, a]),
    );
    return requests.map((request) => {
      const answer = byId.get(request.id);
      if (!answer || answer.jsonrpc !== '2.0') {
        throw new MopidyError(ERROR_KINDS.NOT_MOPIDY, `no JSON-RPC answer to ${request.method}`);
      }
      if (answer.error) {
        const { code, message, data } = answer.error;
        throw new MopidyError(
          ERROR_KINDS.COMMAND,
          `${request.method}: ${errorDetail(message, data)}`,
          { code, method: request.method },
        );
      }
      return answer.result;
    });
  }

  async post(payload) {
    const signal = AbortSignal.timeout(this.timings.requestMs);
    let response;
    try {
      response = await this.fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal,
      });
    } catch (err) {
      throw new MopidyError(ERROR_KINDS.UNREACHABLE, describeFetchError(err));
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new MopidyError(ERROR_KINDS.FORBIDDEN, `HTTP ${response.status}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new MopidyError(ERROR_KINDS.NOT_MOPIDY, `HTTP ${response.status}`);
    }
    let text;
    try {
      text = await readLimited(response, MAX_ANSWER_BYTES);
    } catch (err) {
      throw new MopidyError(
        err.name === 'MopidyError' ? err.kind : ERROR_KINDS.UNREACHABLE,
        err.message,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new MopidyError(ERROR_KINDS.NOT_MOPIDY, 'the answer is not JSON');
    }
  }

  // --- Events --------------------------------------------------------------------

  /**
   * Open the event WebSocket. Resolves true once open, false when it cannot
   * be opened (the caller reads on a timer instead). Events are emitted as
   * `event` ({ event, ...data }); the loss of an open socket as `socket-closed`.
   */
  openEvents() {
    if (this.closed || !this.WebSocketClass) {
      return Promise.resolve(false);
    }
    if (this.socket) {
      return Promise.resolve(true);
    }
    // One opening at a time: two callers must not open two sockets.
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  open() {
    return new Promise((resolve) => {
      let socket;
      try {
        socket = new this.WebSocketClass(this.wsUrl);
      } catch {
        resolve(false);
        return;
      }
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) {
          detach();
          safeClose(socket);
          resolve(false);
        }
      }, this.timings.socketOpenMs);
      timer.unref?.();
      const detach = () => {
        socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      };
      socket.onopen = () => {
        clearTimeout(timer);
        if (this.closed) {
          detach();
          safeClose(socket);
          resolve(false);
          return;
        }
        opened = true;
        this.socket = socket;
        resolve(true);
      };
      socket.onmessage = (message) => this.onMessage(message.data);
      socket.onerror = () => {};
      socket.onclose = () => {
        clearTimeout(timer);
        detach();
        if (!opened) {
          resolve(false);
          return;
        }
        if (this.socket === socket) {
          this.socket = null;
          if (!this.closed) {
            this.emit('socket-closed');
          }
        }
      };
    });
  }

  get eventsOpen() {
    return this.socket !== null;
  }

  onMessage(data) {
    if (typeof data !== 'string' || data.length > MAX_ANSWER_BYTES) {
      return;
    }
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    // The socket also carries JSON-RPC answers; this client sends none on it.
    if (message && typeof message === 'object' && typeof message.event === 'string') {
      this.emit('event', message);
    }
  }

  /** Close the event socket for good. */
  close() {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      safeClose(socket);
    }
  }
}

/** "Application error" says little: Mopidy puts the reason in `data.message`. */
function errorDetail(message, data) {
  const detail = typeof data === 'string' ? data : data?.message;
  return (
    [message, detail].filter((part) => typeof part === 'string' && part !== '').join(': ') ||
    'error'
  );
}

function safeClose(socket) {
  try {
    socket.close();
  } catch {
    // already closed
  }
}

/** The useful part of a fetch failure (undici hides the cause). */
function describeFetchError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return 'no answer (timeout)';
  }
  const cause = err?.cause;
  return cause?.code ?? cause?.message ?? err?.message ?? String(err);
}

/** The body as text, refused past `max` bytes. */
async function readLimited(response, max) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new MopidyError(ERROR_KINDS.NOT_MOPIDY, 'answer too large');
  }
  if (!response.body) {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new MopidyError(ERROR_KINDS.NOT_MOPIDY, 'answer too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
