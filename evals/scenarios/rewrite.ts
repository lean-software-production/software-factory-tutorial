/**
 * Each Part 2 lesson's canonical script is the previous lesson's with one thing
 * changed, which keeps the chain from drifting apart. A `String.replace` that
 * matches nothing returns its input unchanged, so a stale pattern would quietly
 * produce a constant identical to the lesson before it and a gate that passes
 * on the wrong script. This throws instead.
 */
export function rewrite(source: string, from: string | RegExp, to: string): string {
  const result = typeof from === "string" ? source.replace(from, to) : source.replace(from, to);
  if (result === source) throw new Error(`Canonical rewrite matched nothing: ${String(from)}`);
  return result;
}
