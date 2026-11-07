import { useEffect } from 'react';
import { create } from 'zustand';
import type { ServerStatus, Stats, WsClientMessage, WsServerMessage } from '@/api/types';

export interface LogLine {
  id: number;
  text: string;
  kind: 'line' | 'echo' | 'error';
}

export interface Sample {
  t: number;
  mspt: number | null;
  memUsed: number;
  memLimit: number;
  cpu: number;
}

export interface LiveServer {
  logs: LogLine[];
  stats: Stats | null;
  status: ServerStatus | null;
  history: Sample[];
}

type ConnState = 'idle' | 'connecting' | 'open' | 'closed';

interface LiveState {
  conn: ConnState;
  servers: Record<string, LiveServer>;
}

const MAX_LOG = 2000;
export const MAX_SAMPLES = 90; // 3 minutes at one sample per 2 s

export const useLive = create<LiveState>(() => ({ conn: 'idle', servers: {} }));

const empty = (): LiveServer => ({ logs: [], stats: null, status: null, history: [] });
let lineSeq = 0;

function patch(serverId: string, fn: (s: LiveServer) => Partial<LiveServer>) {
  useLive.setState((st) => {
    const cur = st.servers[serverId] ?? empty();
    return { servers: { ...st.servers, [serverId]: { ...cur, ...fn(cur) } } };
  });
}

function appendLines(serverId: string, lines: LogLine[]) {
  patch(serverId, (s) => {
    const logs = s.logs.concat(lines);
    return { logs: logs.length > MAX_LOG ? logs.slice(logs.length - MAX_LOG) : logs };
  });
}

/* ---- Line batching: logs can arrive hundreds at a time on subscribe. ---- */
const pending = new Map<string, LogLine[]>();
let flushScheduled = false;
function queueLine(serverId: string, line: LogLine) {
  const arr = pending.get(serverId) ?? [];
  arr.push(line);
  pending.set(serverId, arr);
  if (!flushScheduled) {
    flushScheduled = true;
    requestAnimationFrame(() => {
      flushScheduled = false;
      for (const [id, lines] of pending) appendLines(id, lines);
      pending.clear();
    });
  }
}

class LiveSocket {
  private ws: WebSocket | null = null;
  private refs = new Map<string, number>();
  private retry = 0;
  private reconnectTimer: number | undefined;
  private idleTimer: number | undefined;

  private url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  private send(msg: WsClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.reconnectTimer);
    useLive.setState({ conn: 'connecting' });
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      useLive.setState({ conn: 'open' });
      for (const id of this.refs.keys()) this.subscribeOnWire(id);
    };
    ws.onmessage = (ev) => this.handle(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      useLive.setState({ conn: 'closed' });
      if (this.refs.size > 0) {
        const delay = Math.min(15000, 1000 * 2 ** this.retry++);
        this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
      }
    };
    ws.onerror = () => ws.close();
  }

  private subscribeOnWire(serverId: string) {
    // The server replays a backlog on subscribe, so start from an empty buffer.
    pending.delete(serverId);
    patch(serverId, () => ({ logs: [] }));
    this.send({ type: 'subscribe', serverId, channels: ['logs', 'stats'] });
  }

  private handle(data: unknown) {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'log':
        queueLine(msg.serverId, { id: ++lineSeq, text: msg.line, kind: 'line' });
        break;
      case 'stats': {
        const st = msg.stats;
        patch(msg.serverId, (s) => {
          const sample: Sample = {
            t: Date.now(),
            mspt: st.mspt?.avg ?? null,
            memUsed: st.memory?.usedMb ?? 0,
            memLimit: st.memory?.limitMb ?? 0,
            cpu: st.cpuPercent ?? 0,
          };
          const history = s.history.concat(sample).slice(-MAX_SAMPLES);
          return { stats: st, status: st.status ?? s.status, history };
        });
        break;
      }
      case 'status':
        patch(msg.serverId, (s) => ({
          status: msg.status,
          stats: s.stats ? { ...s.stats, status: msg.status } : s.stats,
        }));
        break;
      case 'error':
        if (msg.serverId) queueLine(msg.serverId, { id: ++lineSeq, text: msg.message, kind: 'error' });
        else for (const id of this.refs.keys()) queueLine(id, { id: ++lineSeq, text: msg.message, kind: 'error' });
        break;
    }
  }

  acquire(serverId: string) {
    clearTimeout(this.idleTimer);
    const n = this.refs.get(serverId) ?? 0;
    this.refs.set(serverId, n + 1);
    if (n === 0) {
      if (this.ws?.readyState === WebSocket.OPEN) this.subscribeOnWire(serverId);
      else this.connect();
    }
  }

  release(serverId: string) {
    const n = (this.refs.get(serverId) ?? 1) - 1;
    if (n > 0) {
      this.refs.set(serverId, n);
      return;
    }
    this.refs.delete(serverId);
    this.send({ type: 'unsubscribe', serverId });
    if (this.refs.size === 0) {
      // Keep the socket briefly so tab switches don't churn connections.
      this.idleTimer = window.setTimeout(() => {
        if (this.refs.size === 0) {
          const ws = this.ws;
          this.ws = null;
          ws?.close();
          useLive.setState({ conn: 'idle' });
        }
      }, 10000);
    }
  }

  /** Sends a console command; returns false if the socket isn't open. */
  command(serverId: string, command: string): boolean {
    const ok = this.send({ type: 'command', serverId, command });
    if (ok) queueLine(serverId, { id: ++lineSeq, text: `> ${command}`, kind: 'echo' });
    return ok;
  }

  /** Allows REST fallbacks to echo into the same log. */
  note(serverId: string, text: string, kind: LogLine['kind'] = 'echo') {
    queueLine(serverId, { id: ++lineSeq, text, kind });
  }

  reset() {
    this.refs.clear();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    useLive.setState({ conn: 'idle', servers: {} });
  }
}

export const liveSocket = new LiveSocket();

/** Subscribes the component to a server's live log/stats stream for its lifetime. */
export function useLiveServer(serverId: string | undefined): LiveServer & { conn: ConnState } {
  useEffect(() => {
    if (!serverId) return;
    liveSocket.acquire(serverId);
    return () => liveSocket.release(serverId);
  }, [serverId]);
  const server = useLive((s) => (serverId ? s.servers[serverId] : undefined));
  const conn = useLive((s) => s.conn);
  return { ...(server ?? EMPTY), conn };
}
const EMPTY: LiveServer = empty();

/** Clears the locally buffered log for a server (does not touch the server). */
export function clearLogs(serverId: string) {
  patch(serverId, () => ({ logs: [] }));
}

/** Records a stats sample obtained outside the socket (REST fallback) so graphs keep moving. */
export function ingestStats(serverId: string, st: Stats) {
  patch(serverId, (s) => ({
    stats: st,
    status: st.status ?? s.status,
    history: s.history
      .concat({ t: Date.now(), mspt: st.mspt?.avg ?? null, memUsed: st.memory?.usedMb ?? 0, memLimit: st.memory?.limitMb ?? 0, cpu: st.cpuPercent ?? 0 })
      .slice(-MAX_SAMPLES),
  }));
}
