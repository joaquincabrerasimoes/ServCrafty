'use strict';

// Windows games under Wine: console programs such as srcds.exe (Source dedicated servers) call AllocConsole() to make
// their own console. When the container has a TTY, Wine hands them the terminal as an inherited console, AllocConsole
// fails and the game exits with code 255. So the executor never gives Wine the TTY (stdout/stderr are pipes), and the
// text such a game writes to its console shows up in Wine's debug channel instead:
//
//   004c:warn:seh:dispatch_exception "Game.dll loaded for \"Left 4 Dead 2\"\n"
//
// (enabled with WINEDEBUG=fixme-all,warn+seh, set by the game definition). DebugStringFilter turns those lines back
// into the plain text the game printed and drops Wine's own noise on that channel; any other line passes through.

const DEBUG_STRING = /^[0-9a-f]+:warn:seh:dispatch_exception "(.*)"$/;
const SEH_NOISE = /^[0-9a-f]+:warn:seh:dispatch_exception unknown exception \(code=[0-9a-f]+\) raised$/;

const SIMPLE = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', f: '\f', v: '\v', '"': '"', '\\': '\\' };

/** Undo Wine's debugstr escaping (`\n`, `\"`, `\\`, `\xNN`, `\NNN` octal). */
function unescapeDebugString(s) {
  return s.replace(/\\(?:x([0-9a-fA-F]{2})|([0-7]{3})|(.))/g, (m, hex, oct, ch) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    return Object.prototype.hasOwnProperty.call(SIMPLE, ch) ? SIMPLE[ch] : ch;
  });
}

/** Does this WINEDEBUG value ask for the debug-string channel? */
function wantsDebugStrings(winedebug) {
  return /(^|,)warn\+seh(,|$)/.test(winedebug || '');
}

class DebugStringFilter {
  /** @param {(text: string) => void} write receives the text to log */
  constructor(write) {
    this.write = write;
    this.buf = '';
  }

  push(chunk) {
    this.buf += chunk.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      this.line(this.buf.slice(0, i).replace(/\r$/, ''));
      this.buf = this.buf.slice(i + 1);
    }
  }

  flush() {
    if (this.buf) this.line(this.buf);
    this.buf = '';
  }

  line(l) {
    if (SEH_NOISE.test(l)) return;
    const m = DEBUG_STRING.exec(l);
    if (!m) {
      this.write(l + '\n');
      return;
    }
    this.write(unescapeDebugString(m[1]));
  }
}

module.exports = { DebugStringFilter, unescapeDebugString, wantsDebugStrings };
