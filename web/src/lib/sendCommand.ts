import { serversApi } from '@/api';
import { liveSocket } from '@/ws/live';
import { toast } from '@/stores/toast';

/** Sends a console command over the live socket, falling back to REST (RCON) when offline. */
export async function sendCommand(serverId: string, command: string) {
  if (liveSocket.command(serverId, command)) return;
  try {
    liveSocket.note(serverId, `> ${command}`);
    const r = await serversApi.command(serverId, command);
    const out = r && typeof r === 'object' && 'output' in r ? r.output : undefined;
    if (out) for (const line of String(out).split(/\r?\n/)) if (line) liveSocket.note(serverId, line, 'line');
  } catch (e) {
    toast.error(e);
    throw e;
  }
}
