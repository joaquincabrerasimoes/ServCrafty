'use strict';

// Minimal, order-preserving INI editor. Unrelated lines are never touched.
// Section and key names compare case-insensitively (Unreal engine ini files are case-insensitive).

const HEADER = /^\s*\[([^\]]*)\]\s*$/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Ranges [start, end) of every block whose header matches `name`; start is the header line index.
function sectionRanges(lines, name) {
  const want = name.trim().toLowerCase();
  const ranges = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]);
    if (m) {
      if (cur) cur.end = i;
      cur = m[1].trim().toLowerCase() === want ? { start: i, end: lines.length } : null;
      if (cur) ranges.push(cur);
    }
  }
  return ranges;
}

function keyLineRe(key) {
  return new RegExp('^\\s*' + escapeRe(key.trim()) + '\\s*=', 'i');
}

function findKeyLines(lines, ranges, key) {
  const re = keyLineRe(key);
  const idx = [];
  for (const r of ranges) {
    for (let i = r.start + 1; i < r.end; i++) if (re.test(lines[i])) idx.push(i);
  }
  return idx;
}

// Insert lines at the end of the (last) block of the section, before trailing blank lines.
function appendToSection(lines, section, newLines) {
  const ranges = sectionRanges(lines, section);
  if (ranges.length === 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${section}]`, ...newLines);
    return;
  }
  const r = ranges[ranges.length - 1];
  let at = r.end;
  while (at - 1 > r.start && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, ...newLines);
}

function setKey(lines, section, key, value) {
  const ranges = sectionRanges(lines, section);
  const idx = findKeyLines(lines, ranges, key);
  if (idx.length > 0) {
    const m = /^(\s*)([^=]*?)(\s*=\s*)(.*)$/.exec(lines[idx[0]]);
    lines[idx[0]] = `${m[1]}${m[2]}${m[3]}${value}`;
    return;
  }
  appendToSection(lines, section, [`${key}=${value}`]);
}

function setList(lines, section, key, values) {
  const ranges = sectionRanges(lines, section);
  const idx = findKeyLines(lines, ranges, key);
  const newLines = values.map((v) => `${key}=${v}`);
  if (idx.length === 0) {
    if (newLines.length > 0) appendToSection(lines, section, newLines);
    return;
  }
  for (let i = idx.length - 1; i >= 0; i--) lines.splice(idx[i], 1);
  lines.splice(idx[0], 0, ...newLines);
}

/**
 * @param {string|null} text existing file content, or null when the file does not exist
 * @param {{section:string,key:string,value:string}[]} set
 * @param {{section:string,key:string,values:string[]}[]} list
 * @returns {string} new file content
 */
function applyIni(text, set = [], list = []) {
  const src = typeof text === 'string' ? text : '';
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNl = src.length === 0 ? true : /\n$/.test(src);
  const lines = src.length ? src.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '' && endsWithNl) lines.pop();

  for (const e of set) setKey(lines, e.section, e.key, e.value);
  for (const e of list) setList(lines, e.section, e.key, e.values);

  if (lines.length === 0) return '';
  return lines.join(eol) + (endsWithNl ? eol : '');
}

module.exports = { applyIni };
