# Metin2 servers: feasibility notes (parked)

Status: **parked**, not scheduled. Written while investigating a possible v0.5.0 "new game". Nothing here is implemented.

## What a Metin2 server is

- Several cooperating processes, not one program: a **db cache** process, an **auth** (login) process and one **game** process per channel, backed by **MariaDB/MySQL** (several databases).
- Example Linux project reviewed: `metin2-reborn/m2server` (modern C++, one `server` binary whose role db/auth/game is chosen in a TOML file; MariaDB container imports dumps; composed with Podman). Default ports there: auth 11000, first channel 13000, channel-to-channel (P2P) 14000, db cache 15000 (internal only). All are configuration, not fixed.
- Other projects seen: `AzzlackSyndicate/metin2-singleplayer-serverfiles-linux` (Docker stack: cores + MariaDB + admin panel + client builder, no binaries or data), `Zavvv/metin2-server-docker`, `willianmarquess/open-mt2` (Node/TS reimplementation), Old Metin2 Project deploy repo.
- No RCON-like console protocol found. Control would be start/stop/logs plus whatever GM commands the files support.
- Players need a Metin2 client whose `serverinfo` points at the operator's IP and auth port. The client is distributed by the operator, not by the panel.
- The open projects do not ship game data (item/mob tables, quests, locale); the operator supplies it.

## Legal

Most private-server files come from leaks or reverse engineering of proprietary software (Gameforge/Webzen). The license and data origin of the "cleaned-up" projects is unclear (m2server states no license). If this is ever built, ServCrafty must ship **no Metin2 code or data**, only run an image/files the operator supplies, and must not recommend or distribute server files. Hosting stays the operator's own risk.

## Fit with ServCrafty today

- One container per server; Metin2 needs several (including MariaDB).
- The panel's PostgreSQL cannot serve it (needs MySQL/MariaDB).
- No "run any Docker image" game kind yet (SteamCMD games use the SteamCMD image + a JSON definition; Metin2 has no Steam distribution).

## Options considered

1. **Generic "custom image" game kind (recommended first step).** A game kind that runs a user-supplied image with declared ports, volumes and env vars. For Metin2 the user brings an all-in-one image (supervisor + embedded MariaDB). Reusable for any other game. Cheapest.
2. **Multi-container servers.** One server owns several containers (MariaDB + db + auth + game channels). Cleaner for Metin2, but a large change to the runtime state machine (`services/runtime.ts`).
3. **Metin2-specific management** (channel editing, account tools). Only after option 1 works.

## Open questions

- Which server-files distribution or image would be used (decides ports, volumes, database setup)?
- Is the legal exposure acceptable for a public project?
- Is a "bring your own image" kind acceptable, with the panel only running it?
