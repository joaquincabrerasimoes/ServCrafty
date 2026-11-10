import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const UNIT_PATH = '/etc/systemd/system/servcrafty-graceful.service';
const SCRIPT_PATH = '/usr/local/bin/servcrafty-graceful-stop';

/** Asks the panel (on loopback, with the secret key from the unit's environment) to stop every game server. */
export const GRACEFUL_SCRIPT = `#!/bin/sh
# Installed by ServCrafty. Called by servcrafty-graceful.service when the container shuts down.
printf 'header = "X-Servcrafty-Key: %s"\\n' "$SECRET_KEY" | curl -fsS -m 290 -X POST -K - "http://127.0.0.1:\${PORT:-8080}/api/internal/stop-all"
`;

/**
 * A unit that does nothing while the container is up and, when systemd stops it (container shutdown or
 * reboot), asks the panel to stop every game server cleanly. It is ordered after servcrafty.service and
 * docker.service, so on shutdown it stops BEFORE them and the panel and Docker are still alive. Restarting
 * servcrafty.service (self-update) does not stop it, so updates still leave game servers running.
 */
export const GRACEFUL_UNIT = `[Unit]
Description=Gracefully stop ServCrafty game servers on shutdown
After=servcrafty.service docker.service network.target

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=/etc/servcrafty/env
ExecStart=/bin/true
ExecStop=${SCRIPT_PATH}
TimeoutStopSec=300

[Install]
WantedBy=multi-user.target
`;

async function writeIfChanged(path: string, content: string, mode: number): Promise<boolean> {
  const current = await fsp.readFile(path, 'utf8').catch(() => null);
  if (current === content) return false;
  await fsp.writeFile(path, content, { mode });
  await fsp.chmod(path, mode);
  return true;
}

/** Install and enable the shutdown unit on LXC installs (idempotent; failures are only logged by the caller). */
export async function ensureGracefulUnit(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const a = await writeIfChanged(SCRIPT_PATH, GRACEFUL_SCRIPT, 0o755);
  const b = await writeIfChanged(UNIT_PATH, GRACEFUL_UNIT, 0o644);
  if (!a && !b) return false;
  await run('systemctl', ['daemon-reload']);
  await run('systemctl', ['enable', '--now', 'servcrafty-graceful.service']);
  return true;
}
