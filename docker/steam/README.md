# ServCrafty SteamCMD image

`ghcr.io/<owner>/servcrafty-steamcmd` runs any SteamCMD game from a plan file written by the panel. The contract is in
[SPEC.md](../../SPEC.md), section "SteamCMD games (v0.3.0)" ("Plan" and "Image").

## How it works

Debian bookworm with SteamCMD (`/opt/steamcmd`), 32-bit libs, Debian Wine + Xvfb (Windows servers), `tini` as PID 1 and
Node 22 for the executor `/usr/local/bin/servcrafty-steam-run` (sources in `src/`, zero npm dependencies).

The container starts as root, reads `/servcrafty/plan.json`, chowns `/data` to uid/gid 1000 (user `steam`, home
`/data/steam`), then permanently drops to that user. Everything else, including the game, runs as uid 1000.

Phases (each prints a marker):

1. `install`: SteamCMD self-update, then `+force_install_dir /data/game +login anonymous +app_update <appid> [-beta b [-betapassword p]] [validate]`
   (`+@sSteamCmdForcePlatformType windows` for Windows games). Skipped when `steam.update` is false and `/data/game` is not empty.
   Retried up to 3 times on exit codes 8/10, "Missing configuration" and "Timeout"; "no space" (state 0x202/0x602) is never retried.
2. `workshop`: `+workshop_download_item` into `/data/workshop`; with `install: "steamcmd"` the files are copied into `/data/game/<dir>`
   and tracked in `/data/steam/workshop-manifest.json` (only tracked copies are ever removed); `config-list` only downloads.
3. `configure`, in this order: `scripts.postInstall` (every start, so it can seed files), `files` ops (`template`, `ini`), Wine prefix init (Windows games), `scripts.preStart`. Scripts run with cwd `/data/game`.
4. `launch`: exec the argv in `/data/game/<cwd>` (Windows: `xvfb-run -a wine ...`, `WINEPREFIX=/data/steam/wineprefix`).
   On SIGTERM/SIGINT/SIGHUP the executor applies `plan.stop` (signal to the game's process group, or the command written to its stdin),
   waits `timeoutSec`, then SIGKILL. It exits with the game's exit code.

Stdout markers (parsed by the panel):

```
[servcrafty-steam] phase=install|workshop|configure|launch
[servcrafty-steam] progress=<0-100>
[servcrafty-steam] error=<text>        (followed by a non-zero exit)
```

Other lines are free-form. Plan values (passwords) are never printed; only the program name and argument count are shown for the launch command.

## Try it manually

```sh
mkdir -p /tmp/sc/data && cat > /tmp/sc/plan.json <<'EOF'
{"schema":1,"serverName":"test",
 "steam":{"appId":1690800,"branch":null,"betaPassword":null,"platform":"linux","login":"anonymous","validate":false,"update":true},
 "workshop":null,"files":[],
 "launch":{"cwd":"","argv":["./FactoryServer.sh","-Port=7777"],"env":{}},
 "stop":{"type":"signal","signal":"SIGINT","command":"","timeoutSec":60},
 "console":{"stdin":false},"ready":null,"scripts":{"postInstall":null,"preStart":null}}
EOF
docker run --rm -it -v /tmp/sc/data:/data -v /tmp/sc/plan.json:/servcrafty/plan.json:ro -p 7777:7777/udp -p 7777:7777/tcp \
  ghcr.io/<owner>/servcrafty-steamcmd:latest
```

Build locally: `docker build -t servcrafty-steamcmd docker/steam`.

## Tests

No Docker or SteamCMD needed:

```sh
cd docker/steam && node --test
```

`--dry-run` prints what would run without executing SteamCMD or the game; file ops are applied under `SERVCRAFTY_ROOT`
(plan read from `$SERVCRAFTY_ROOT/servcrafty/plan.json`, or `--plan <file>` / `SERVCRAFTY_PLAN`):

```sh
SERVCRAFTY_ROOT=/tmp/root node src/main.js --dry-run
```
