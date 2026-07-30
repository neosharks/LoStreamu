// Pure HTTP Range resolution for the video stream route. Kept separate from the
// Express handler so the byte-math (the part that decides what plays) is unit
// testable without sockets. See RFC 7233.

export type RangeResult =
  | { kind: 'range'; start: number; end: number }   // → 206 Partial Content
  | { kind: 'full' }                                 // no/blank Range → 200 whole file
  | { kind: 'unsatisfiable' };                       // → 416

// Resolve a Range header against a file of `total` bytes.
//   • `bytes=0-`      open-ended → bounded to `chunk` bytes so playback starts
//     immediately and the player streams/seeks the rest.
//   • `bytes=500-999` explicit window, clamped to the file.
//   • `bytes=-N`      suffix: the last N bytes (players fetch a trailing moov).
// Anything malformed or outside the file is reported unsatisfiable (→ 416),
// never a broken 206 that stalls or scrambles playback.
export function resolveRange(rangeHeader: string | undefined, total: number, chunk: number): RangeResult {
  if (!rangeHeader) return { kind: 'full' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return { kind: 'unsatisfiable' };
  const rawStart = m[1] ?? '';
  const rawEnd = m[2] ?? '';
  if (rawStart === '' && rawEnd === '') return { kind: 'unsatisfiable' };

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(rawStart, 10);
    if (!Number.isFinite(start)) return { kind: 'unsatisfiable' };
    end = rawEnd !== ''
      ? Math.min(parseInt(rawEnd, 10), total - 1)
      : Math.min(start + chunk - 1, total - 1);
  }

  if (!Number.isFinite(end) || start < 0 || start >= total || end < start) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'range', start, end };
}
