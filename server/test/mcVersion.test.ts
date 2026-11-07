import assert from 'node:assert/strict';
import test from 'node:test';
import { detectMcVersion } from '../src/lib/mcVersion.js';

test('reads the Minecraft version from server and loader banners', () => {
  assert.equal(detectMcVersion('[22:15:34 INFO]: Starting minecraft server version 1.21.4'), '1.21.4');
  assert.equal(detectMcVersion('[main/INFO] (FabricLoader) Loading Minecraft 1.21.1 with Fabric Loader 0.16.9'), '1.21.1');
  assert.equal(detectMcVersion('[2026-01-01 10:00:00:123 INFO] Version: 1.21.50.7'), '1.21.50.7');
});

test('ignores mod and pack versions that look like "Version: x.y.z"', () => {
  assert.equal(detectMcVersion('[main/INFO]: Fabulously Optimized Version: 3.2.18'), null);
  assert.equal(detectMcVersion('[22:15:35 INFO]: [Essentials] Version: 2.20.1'), null);
  assert.equal(detectMcVersion('[00:00:01] [main/INFO]: Loading Fabulously Optimized 3.2.18'), null);
});
