'use strict';

// Machine-readable marker lines (SPEC.md, "Image"). The panel parses these from stdout.
const PREFIX = '[servcrafty-steam]';

let out = (line) => process.stdout.write(line + '\n');

function setOutput(fn) {
  out = fn;
}

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function marker(key, value) {
  out(`${PREFIX} ${key}=${oneLine(value)}`);
}

function phase(name) {
  marker('phase', name);
}

function progress(n) {
  marker('progress', Math.max(0, Math.min(100, Math.floor(n))));
}

function error(text) {
  marker('error', text);
}

// Free-form executor log line (never contains secrets).
function info(text) {
  out(`[executor] ${text}`);
}

module.exports = { PREFIX, marker, phase, progress, error, info, setOutput, oneLine };
