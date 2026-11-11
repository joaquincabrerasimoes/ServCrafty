# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ServCrafty is a self-hosted game-server panel. Each game server runs in its own Docker container. Supported games: Minecraft (Java and Bedrock), Terraria (vanilla, TShock, tModLoader) and any SteamCMD game described by a JSON "game definition". Backend: Node 22 + TypeScript (ESM) Fastify in `server/`, PostgreSQL, `dockerode`. Frontend: React 18 + Vite + Tailwind PWA in `web/` (i18n en + es). npm workspaces: `server`, `web`.

## Commands

```bash
npm install                          # both workspaces, from the repo root
npm run dev:server                   # API on :8080 (tsx watch, loads ../.env)
npm run dev:web                      # Vite on :5173, proxies /api and /ws to :8080
npm run build                        # web, then server
cd server && npm run typecheck       # tsc --noEmit
cd server && npm test                # all unit tests (tsx --test test/*.test.ts); no Docker or DB needed
cd server && npx tsx --test test/steamPlan.test.ts                      # one test file
cd server && npx tsx --test --test-name-pattern "offset" test/*.test.ts # tests by name
cd server && npx tsx scripts/validate-game.ts games/*.json              # validate built-in game definitions
cd web && npx tsc -b                 # web typecheck (there is no linter); `npx vite build` for a build
cd docker/steam && node --test       # tests of the SteamCMD executor (plain Node, zero dependencies)
cd server && npm run migrate         # apply migrations only
```

`.env` (copy `.env.example`) must point at a **dev** database (`serv_crafty_dev`), never production. There is no Docker daemon on the usual dev machine (Windows): container behaviour cannot be run locally, so it is covered by unit tests with injected dependencies. When smoke-testing the API start the server on a spare port and stop it afterwards.

## Architecture

**`SPEC.md` is the binding contract** (data model, REST/WebSocket API, per-feature sections such as "Other games: Terraria" and "SteamCMD games"). Update it when behaviour changes; implementation deviations are listed at its end.

**Multi-game model.** `servers.type` is the variant (`PAPER`, `TSHOCK`, `STEAMCMD`, ...); `servers.game` (`minecraft | terraria | steam`) is always derived by `gameOf(type)` in `server/src/lib/games.ts` and never trusted from the client. Per-game config lives in JSONB columns (`minecraft`, `terraria`, `steam`, `extra_ports`). Game differences are expressed as capability flags (`capsOf` in `web/src/lib/games.ts`, `capabilitiesOf` server-side); add behaviour behind those instead of `if (type === ...)` branches. A new server `type` needs a migration widening `servers_type_check`, and an entry in `validation.ts`, `web/src/api/types.ts` and the i18n `type.*` keys.

**Runtime (`server/src/services/runtime.ts`).** The central state machine for every container: start/stop/restart, log and stats streams, status transitions (`installing`/`starting`/`running`/`stopping`/`crashed`), crash auto-restart, auto-start at boot, `stopAllServers` for host shutdown. Container creation is per game: `services/docker.ts` (Minecraft, itzg images + RCON), `lib/terrariaContainer.ts`, `lib/steamContainer.ts`. Console is RCON (Java), `docker attach` stdin (Terraria, Steam) or `docker exec` inject (tModLoader).

**SteamCMD games.** Flow: a definition (`server/games/*.json` built-ins, custom ones in `game_definitions`; schema and validator in `lib/gameDefinition.ts`) + the server's `steam.vars` → `lib/steamPlan.ts` renders a **plan** (`$DATA_DIR/steam-plans/<id>.json`, mode 0600, mounted at `/servcrafty/plan.json`) → the dumb executor in `docker/steam/` (image `servcrafty-steamcmd`, built by the release workflow) installs via SteamCMD, writes config files, downloads Workshop items and execs the game, printing `[servcrafty-steam] phase=/progress=/error=` marker lines that the runtime parses. Related: `routes/steam.ts` (Workshop, update, regenerate), `lib/steamWorkshop.ts`, `services/portAlloc.ts` + `steamPorts.ts` (several ports per server, mirror ports, offsets), `lib/a2s.ts` (query), `routes/webui.ts` + `lib/webuiProxy.ts` (token-scoped, sandboxed reverse proxy with WebSocket bridge for the games' own web admin pages). `docs/games.md` is the authoring guide for definitions.

**BlueMap (v0.4.0).** Optional per Java server (`servers.bluemap`, `lib/bluemap.ts` pure helpers, `services/bluemap.ts` DB provisioning + config files, `routes/bluemap.ts`). Each server gets a PostgreSQL schema and role `bluemap_<uuid>` in the panel's own database (needs CREATEROLE); itzg installs the mod/plugin via `MODRINTH_PROJECTS`; the map is viewed through the web UI proxy as built-in UI id `bluemap` (`routes/webui.ts`). The runtime calls `prepareBluemap` before creating a container and `deleteServer` drops the schema.

**Ports.** Host ports come from an admin-configured pool (`port_pool` setting); `servers.port` is the main port, other published ports are in `extra_ports`. Terraria maps the host port to container 7777.

**Auth and settings.** Cookie sessions or `Bearer scf_...` API tokens, TOTP/passkeys, per-server sharing levels (viewer/operator/manager). The bootstrap admin and admins without 2FA are LAN-only once `lan_networks` is set (`lib/network.ts`, `services/lanOnly.ts`: Cloudflare headers or a socket outside the range mean "remote"). Runtime-editable settings live in the `settings` table (`services/settings.ts`: port pool, public URLs, CurseForge/Steam keys, host-wide caps in `globalLimits.ts`). `routes/internal.ts` is loopback-only (systemd shutdown hook).

**Deployment and self-update.** Docker image (bundled dockerd) or a Proxmox LXC install (`lxc/`). The LXC panel updates itself from GitHub releases (`services/updater.ts` + `lxc/apply-update.sh`, restarts only the panel; game containers keep running) and installs `servcrafty-graceful.service` at boot so a container shutdown stops game servers cleanly (`lib/gracefulUnit.ts`). `server/migrations/*.sql` run automatically at boot.

**Frontend.** TanStack Query for data, `useServerCtx()` from `pages/server/ServerLayout.tsx` for the current server on server pages, one websocket (`web/src/ws/`) for live logs/stats. All user-visible strings go through `t()`; `en.ts` and `es.ts` are type-checked for key parity, so every new key must be added to both.

## Conventions and gotchas

- Releases: `bash scripts/release.sh X.Y.Z` bumps versions, commits "Release vX.Y.Z" and tags; then push `main` and the tag. The tag triggers the GitHub Action (panel image, SteamCMD image, GitHub Release). The tag must equal `server/package.json`'s version.
- **Do not create a root `package-lock.json`.** It is deliberately absent; one generated on Windows lacks Linux optional packages (rollup) and breaks the Docker build. Be careful with `npm install <pkg>` run inside `server/` or `web/`: it can create it. Check `git status` after adding dependencies.
- Never put AI/Claude attribution (Co-Authored-By, "Generated with") in commits or PR text. Do not commit, tag, push or release until the owner asks.
- Repo files use LF (`.gitattributes`); on Windows the working copy may show CRLF warnings, which are harmless.
- Secrets never go into the repo: `.env` is gitignored, and the examples contain placeholders only.
- Game definitions and plans: user-supplied values are never interpolated into shell strings (launch is an argv array); secrets are never logged.
