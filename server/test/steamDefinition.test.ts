import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mainPort, parseDefinition, templateRefs, unsafeRelPathReason, validateDefinition } from '../src/lib/gameDefinition.js';
import { readDefinitionDir } from '../src/services/gameDefinitions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures', 'games');
const fixture = (): Record<string, any> => JSON.parse(readFileSync(path.join(fixturesDir, 'test-game.json'), 'utf8'));

/** Validate a mutated copy of the fixture and return the error paths+messages. */
function errorsOf(mutate: (d: Record<string, any>) => void): string[] {
  const d = fixture();
  mutate(d);
  const r = validateDefinition(d);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
}

const hasError = (errs: string[], re: RegExp) => assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);

test('the fixture definition is valid and defaults are filled', () => {
  const r = validateDefinition(fixture());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  if (!r.ok) return;
  const d = r.definition;
  assert.equal(d.ports[0]!.publish, true);
  assert.equal(d.ports[1]!.mirror, true);
  assert.equal(d.webui[0]!.minAccess, 'manager');
  assert.equal(mainPort(d).id, 'game');
});

test('minimal definition: defaults for optional sections, first port is main', () => {
  const d = parseDefinition({
    schema: 1,
    id: 'mini',
    name: 'Mini',
    steam: { appId: 10 },
    resources: { memoryMb: 1024, memoryMinMb: 512, cpu: 1 },
    ports: [
      { id: 'a', label: 'A', protocol: 'udp', containerPort: 1000 },
      { id: 'b', label: 'B', protocol: 'tcp', containerPort: 1001 },
    ],
    launch: { command: ['./run'] },
  });
  assert.equal(mainPort(d).id, 'a');
  assert.deepEqual(d.stop, { type: 'signal', signal: 'SIGINT', timeoutSec: 60 });
  assert.deepEqual(d.console, { stdin: false });
  assert.equal(d.steam.platform, 'linux');
  assert.equal(d.steam.login, 'anonymous');
  assert.equal(d.workshop, null);
  assert.deepEqual(d.webui, []);
});

test('unknown keys are rejected everywhere (strict)', () => {
  hasError(errorsOf((d) => (d.extra = 1)), /Unrecognized key/);
  hasError(errorsOf((d) => (d.ports[0].foo = 1)), /^ports\.0: Unrecognized key/);
  hasError(errorsOf((d) => (d.launch.shell = 'sh -c x')), /^launch: Unrecognized key/);
  hasError(errorsOf((d) => (d.steam.login = 'someone')), /^steam\.login/);
});

test('templates: unknown names, unknown ports, malformed braces', () => {
  hasError(errorsOf((d) => d.launch.command.push('-X={{nope}}')), /unknown template name "\{\{nope\}\}"/);
  hasError(errorsOf((d) => d.launch.command.push('-P={{ports.nope}}')), /unknown port "nope"/);
  hasError(errorsOf((d) => d.launch.command.push('-P={{maxPlayers')), /malformed template/);
  hasError(errorsOf((d) => (d.files[0].content = '{{ 1bad }}')), /malformed template name/);
  hasError(errorsOf((d) => (d.webui[0].auth.password = '{{secret}}')), /^webui\.0\.auth\.password: unknown template/);
  hasError(errorsOf((d) => (d.launch.env.X = '{{server.owner}}')), /unknown template name/);
  // Built-in names are fine.
  assert.deepEqual(errorsOf((d) => d.launch.command.push('{{server.name}}', '{{server.id}}', '{{workshop.ids}}', '{{ maxPlayers }}')), []);
  assert.deepEqual(templateRefs('a {{x}} b {{ ports.y }}'), ['x', 'ports.y']);
});

test('launch: "if" must reference a variable; argv[0] unconditional', () => {
  hasError(errorsOf((d) => d.launch.command.push({ value: '-x', if: 'missing' })), /"if" must reference a variable/);
  hasError(errorsOf((d) => (d.launch.command[0] = { value: './x', if: 'password' })), /must be unconditional/);
  hasError(errorsOf((d) => (d.launch.command = 'sh -c "./x"')), /^launch\.command/);
});

test('paths: no "..", not absolute, forward slashes, no templates', () => {
  hasError(errorsOf((d) => (d.files[0].path = '../etc/passwd')), /files\.0\.path: path must not contain '\.\.'/);
  hasError(errorsOf((d) => (d.files[0].path = 'Config/../../x')), /'\.\.'/);
  hasError(errorsOf((d) => (d.files[0].path = '/etc/passwd')), /must be relative/);
  hasError(errorsOf((d) => (d.files[0].path = 'C:/x')), /must be relative/);
  hasError(errorsOf((d) => (d.files[0].path = 'a\\b')), /forward slashes/);
  hasError(errorsOf((d) => (d.files[0].path = 'Config/{{serverName}}.cfg')), /templates/);
  hasError(errorsOf((d) => (d.launch.cwd = '../')), /launch\.cwd/);
  hasError(errorsOf((d) => (d.files[1].path = d.files[0].path)), /declared twice/);
  assert.equal(unsafeRelPathReason('a/b/c.ini'), null);
  assert.equal(unsafeRelPathReason('', true), null);
});

test('ports: exactly one main, unique ids, main published, mirror published, overlapping container ports', () => {
  hasError(errorsOf((d) => (d.ports[1].main = true)), /exactly one port/);
  hasError(errorsOf((d) => (d.ports[1].id = 'game')), /duplicate port id/);
  hasError(errorsOf((d) => (d.ports[0].publish = false)), /main port must be published/);
  hasError(errorsOf((d) => (d.ports[1].publish = false)), /mirror port must be published/);
  hasError(errorsOf((d) => (d.ports[2].containerPort = 7777)), /7777\/tcp is declared twice/);
  hasError(errorsOf((d) => (d.ports = [])), /^ports/);
});

test('cross references: webui port, a2s port, valuesFrom, workshop dir, stdin stop', () => {
  hasError(errorsOf((d) => (d.webui[0].portId = 'nope')), /webui\.0\.portId: unknown port/);
  hasError(errorsOf((d) => (d.webui[0].portId = 'query')), /web UI port must be tcp/);
  hasError(errorsOf((d) => (d.webui[0].path = 'ServerAdmin')), /must start with "\/"/);
  hasError(errorsOf((d) => (d.webui[0].path = '/a/../b')), /plain absolute path/);
  hasError(errorsOf((d) => (d.query.a2s.portId = 'nope')), /query\.a2s\.portId: unknown port/);
  hasError(errorsOf((d) => (d.query.a2s.portId = 'web')), /must be udp/);
  hasError(errorsOf((d) => (d.files[1].list[1].valuesFrom = 'var:nope')), /variable "nope" is not defined/);
  hasError(errorsOf((d) => (d.workshop = null)), /"workshop" requires a "workshop" section/);
  hasError(errorsOf((d) => (d.workshop = { appId: 1, install: 'steamcmd' })), /workshop\.dir: required/);
  hasError(errorsOf((d) => (d.workshop = { appId: 1, install: 'steamcmd', dir: '../x' })), /workshop\.dir/);
  hasError(errorsOf((d) => (d.console.stdin = false)), /stdin stop requires/);
  hasError(errorsOf((d) => delete d.stop.command), /stdin stop needs a command/);
  hasError(errorsOf((d) => (d.webui.push({ ...d.webui[0] }))), /duplicate web UI id/);
});

test('variables: types, defaults, options, pattern, reserved keys', () => {
  hasError(errorsOf((d) => (d.variables[1].default = 'eight')), /variables\.1\.default: must be a number/);
  hasError(errorsOf((d) => (d.variables[1].default = 100)), /above max/);
  hasError(errorsOf((d) => (d.variables[1].default = 2.5)), /integer/);
  hasError(errorsOf((d) => (d.variables[5].default = 'pvp')), /one of the options/);
  hasError(errorsOf((d) => delete d.variables[5].options), /select variables need options/);
  hasError(errorsOf((d) => (d.variables[0].pattern = '([a-z')), /invalid regular expression/);
  hasError(errorsOf((d) => Object.assign(d.variables[0], { pattern: '[a-z]+', default: 'ABC' })), /does not match pattern/);
  hasError(errorsOf((d) => (d.variables[0].key = 'ports')), /reserved/);
  hasError(errorsOf((d) => (d.variables[1].key = 'serverName')), /duplicate variable key/);
  hasError(errorsOf((d) => (d.variables[0].default = 'a\nb')), /control characters/);
  hasError(errorsOf((d) => (d.variables[0].key = 'bad-key')), /variable key must match/);
});

test('regexes and ids', () => {
  hasError(errorsOf((d) => (d.ready.logRegex = '(')), /ready\.logRegex: invalid regular expression/);
  hasError(errorsOf((d) => (d.players.joinRegex = 'joined')), /named group/);
  hasError(errorsOf((d) => (d.id = 'Bad_Id')), /^id: id must match/);
  hasError(errorsOf((d) => (d.id = 'a')), /^id/);
  hasError(errorsOf((d) => (d.icon = 'http://x/y.png')), /https URL/);
  hasError(errorsOf((d) => (d.resources.memoryMinMb = 99999)), /<= resources\.memoryMb/);
  hasError(errorsOf((d) => (d.files[1].set[0].section = 'a]b')), /must not contain "\]"/);
});

test('readDefinitionDir loads valid files and reports the rest', async () => {
  const r = await readDefinitionDir(fixturesDir);
  assert.deepEqual(
    r.ok.map((d) => d.id),
    ['test-game'],
  );
  assert.deepEqual(r.failed, []);
  const missing = await readDefinitionDir(path.join(fixturesDir, 'does-not-exist'));
  assert.deepEqual(missing, { ok: [], failed: [] });
});
