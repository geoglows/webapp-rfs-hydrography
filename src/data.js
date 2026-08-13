export function upstreamRange({riverIndex, upstreamCount}) {
  const hi = Number(riverIndex);
  const n = Number(upstreamCount);
  if (!Number.isInteger(hi) || hi < 0) throw new Error(`riverIndex ${riverIndex} is not an index`);
  if (!Number.isInteger(n) || n < 0) throw new Error(`upstreamCount ${upstreamCount} is not a count`);
  return {lo: hi - n, hi, count: n + 1};
}
