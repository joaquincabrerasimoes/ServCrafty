'use strict';

const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

const MAX_READ = 1024 * 1024;

// Streams the new content of a file the game writes its console to (for example srcds `-condebug`) to `write`.
// Starts at the beginning of the file (the caller removes a stale one first), copes with the file appearing later and
// with truncation, and `stop()` does a last read so nothing written just before the game exits is lost.
function tailFile(file, write, { intervalMs = 250 } = {}) {
  let offset = 0;
  const decoder = new StringDecoder('utf8');

  const poll = () => {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < offset) offset = 0; // truncated or replaced
      while (offset < size) {
        const buf = Buffer.allocUnsafe(Math.min(MAX_READ, size - offset));
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        if (n <= 0) break;
        offset += n;
        const text = decoder.write(buf.subarray(0, n));
        if (text) write(text);
      }
    } catch {
      /* not there yet */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };

  const timer = setInterval(poll, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      poll();
      const rest = decoder.end();
      if (rest) write(rest);
    },
  };
}

module.exports = { tailFile };
