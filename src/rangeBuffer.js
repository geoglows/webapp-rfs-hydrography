/**
 * A hyparquet AsyncBuffer whose range reads report bytes as they arrive.
 *
 * hyparquet's own `asyncBufferFromUrl` resolves a slice to an ArrayBuffer in one step, so a 30 MB
 * row-group span is a single await with nothing to show for it until it lands — and that await is
 * most of the wait on a geometry download. This wraps the same interface and streams the response
 * body instead, so the caller can report bytes actually transferred rather than leave the bar
 * sitting still.
 */
export function streamingBuffer(base, url, onBytes) {
  if (typeof fetch !== 'function') return base;
  return {
    byteLength: base.byteLength,
    async slice(start, end) {
      const to = end ?? base.byteLength;
      const want = to - start;
      if (want <= 0) return new ArrayBuffer(0);
      let resp;
      try {
        // HTTP ranges are inclusive at both ends; hyparquet's are half-open.
        resp = await fetch(url, {headers: {range: `bytes=${start}-${to - 1}`}});
      } catch {
        resp = null;
      }
      if (!resp || !resp.ok || !resp.body) {
        const buf = await base.slice(start, end);
        onBytes?.(buf.byteLength);
        return buf;
      }

      // 206 means the window arrived. A 200 means the server ignored Range and sent everything,
      // so the window has to be cut out of the whole file rather than assumed to be the response.
      const whole = resp.status === 200 && want < base.byteLength;
      const size = whole ? base.byteLength : want;
      const out = new Uint8Array(size);
      const reader = resp.body.getReader();
      let off = 0;
      for (; ;) {
        const {done, value} = await reader.read();
        if (done) break;
        // A server sending more than advertised would otherwise throw inside set().
        const n = Math.min(value.length, size - off);
        if (n > 0) out.set(value.subarray(0, n), off);
        off += n;
        onBytes?.(value.length);
      }
      const view = whole ? out.subarray(start, to) : out.subarray(0, off);
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    },
  };
}

/**
 * Rate-limited progress reporting.
 *
 * Streaming a 30 MB span in ~64 KB chunks is ~500 callbacks; forwarding each one as a postMessage
 * or a style write costs more than the information is worth. `emit` passes one through only when
 * the value has moved enough to see or enough time has passed to look stalled.
 */
export function throttle(fn, {minDelta = 0.25, minMs = 80} = {}) {
  let lastVal = -Infinity, lastAt = -Infinity;
  const call = (val, ...rest) => {
    lastVal = val;
    lastAt = performance.now();
    fn(val, ...rest);
  };
  return {
    emit(val, ...rest) {
      if (val - lastVal >= minDelta || performance.now() - lastAt >= minMs) call(val, ...rest);
    },
    flush(val, ...rest) {
      call(val, ...rest);
    },
  };
}
