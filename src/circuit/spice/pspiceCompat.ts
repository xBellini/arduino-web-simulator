/**
 * What: Mechanical PSpice-to-ngspice rewrites applied to deck + library text before it reaches
 * eecircuit-engine (ngspice-45.2 WASM, no XSPICE code models). Modern ngspice maps E TABLE and
 * ps-mode VSWITCH onto XSPICE (`xfer` / `aswitch`) and POLY onto XSPICE too, so without code
 * models those constructs fail or kill the engine; these rewrites express the same math with
 * built-in devices.
 *
 * Owns/exports: `convertPspiceCompat` (all rewrites, in order), `convertTables`, `convertVswitch`,
 * `convertPoly`, `findUnsupportedConstructs`, `parseSpiceNumber`.
 *
 * Conventions:
 * - `+` continuation lines are joined first; output is one card per line.
 * - E TABLE → B `pwl(...)` with flat end extension of ±2.5 on x (same shape ngspice-26 itself
 *   produced when it translated TABLE).
 * - VSWITCH → SW with `VT=(VON+VOFF)/2`, `VH=|VON-VOFF|/2` (brace expressions, so `{PARAM}` works).
 * - POLY(n): coefficients in SPICE order — c0, then each total degree with exponent tuples in
 *   descending lexicographic order (POLY(2): c0, x1, x2, x1², x1·x2, x2², x1³ …). A lone POLY(1)
 *   coefficient is the gain c1. E/H → `B … V={…}`, G/F → `B … I={…}` (same current sign as G).
 * - Verified on eecircuit-engine against hand-computed POLY values, TI SN74HC08 and TI uA741.
 *
 * Not here: Running the engine (spice/worker.ts) or deck generation (netlistExport).
 *
# Changelog
# Date       | Author | Remarks
# 09-10-2026 | Cursor | Changelog creation (TABLE / VSWITCH / POLY rewrites + unsupported scan)
#                     | VSWITCH regex: match spaces/tabs only, so it can't swallow the newline and merge the next `.MODEL` line
#                     | Moved from `src/sim/spice/pspiceCompat.ts` (tree reorganization)
 */


const SUFFIX: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  mil: 25.4e-6,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
};

export function parseSpiceNumber(tok: string): number {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(meg|mil|[tgkmunpf])?[a-z]*$/i.exec(tok);
  if (!m) throw new Error(`not a SPICE number: ${tok}`);
  return Number(m[1]) * (m[2] ? SUFFIX[m[2].toLowerCase()]! : 1);
}

function joinContinuations(src: string): string {
  return src.replace(/\r?\n[ \t]*\+/g, ' ');
}

export function convertTables(src: string): string {
  return src.replace(
    /^E(\S+)\s+(\S+)\s+(\S+)\s+TABLE\s*\{([^}]*)\}\s*=?\s*((?:\(\s*[-\d.eE+]+\s*,\s*[-\d.eE+]+\s*\)\s*)+)/gim,
    (_m, name: string, np: string, nn: string, expr: string, pairsTxt: string) => {
      const pts = [...pairsTxt.matchAll(/\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)/g)].map(
        (p) => [Number(p[1]), Number(p[2])] as const,
      );
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      const ext = [[first[0] - 2.5, first[1]], ...pts, [last[0] + 2.5, last[1]]];
      return `BE${name} ${np} ${nn} V=pwl(${expr}, ${ext.map(([x, y]) => `${x},${y}`).join(', ')})\n`;
    },
  );
}

export function convertVswitch(src: string): string {
  return src.replace(
    /^\.MODEL[ \t]+(\S+)[ \t]+VSWITCH[ \t]*\(?[ \t]*VON[ \t]*=[ \t]*\{?([^}\s]+)\}?[ \t]+VOFF[ \t]*=[ \t]*\{?([^}\s]+)\}?[ \t]+RON[ \t]*=[ \t]*([-\d.eE+a-z]+)[ \t]+ROFF[ \t]*=[ \t]*([-\d.eE+a-z]+)[ \t]*\)?/gim,
    (_m, name: string, von: string, voff: string, ron: string, roff: string) =>
      `.MODEL ${name} SW VT={((${von})+(${voff}))/2} VH={abs((${von})-(${voff}))/2} RON=${ron} ROFF=${roff}`,
  );
}

/** Exponent tuples for `dims` variables in SPICE POLY coefficient order (after c0). */
function polyExponentOrder(dims: number, count: number): number[][] {
  const out: number[][] = [];
  for (let deg = 1; out.length < count; deg++) {
    const rec = (i: number, left: number, cur: number[]): void => {
      if (i === dims - 1) {
        out.push([...cur, left]);
        return;
      }
      for (let e = left; e >= 0; e--) rec(i + 1, left - e, [...cur, e]);
    };
    rec(0, deg, []);
  }
  return out.slice(0, count);
}

function polyExpression(vars: string[], coeffs: number[]): string {
  const cs = vars.length === 1 && coeffs.length === 1 ? [0, coeffs[0]!] : coeffs;
  const terms: string[] = [];
  if (cs[0] !== 0) terms.push(`${cs[0]}`);
  polyExponentOrder(vars.length, cs.length - 1).forEach((ex, i) => {
    const c = cs[i + 1]!;
    if (c === 0) return;
    const factors = ex
      .map((e, k) => (e === 0 ? null : e === 1 ? vars[k]! : `${vars[k]}**${e}`))
      .filter((f): f is string => f !== null)
      .join('*');
    terms.push(`(${c})*${factors}`);
  });
  return terms.length ? terms.join(' + ') : '0';
}

export function convertPoly(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => {
      const m = /^\s*([EGFH]\S*)\s+(\S+)\s+(\S+)\s+POLY\s*\(\s*(\d+)\s*\)\s*(.*)$/i.exec(line);
      if (!m) return line;
      const [, name, np, nn, dimTxt, rest] = m as unknown as [string, string, string, string, string, string];
      const dims = Number(dimTxt);
      const kind = name[0]!.toUpperCase();
      const toks = rest.replace(/[(),]/g, ' ').trim().split(/\s+/).filter(Boolean);
      const vars: string[] = [];
      let i = 0;
      if (kind === 'E' || kind === 'G') {
        for (let d = 0; d < dims; d++, i += 2) vars.push(`V(${toks[i]},${toks[i + 1]})`);
      } else {
        for (let d = 0; d < dims; d++, i += 1) vars.push(`I(${toks[i]})`);
      }
      const coeffs = toks.slice(i).map(parseSpiceNumber);
      const q = kind === 'E' || kind === 'H' ? 'V' : 'I';
      return `B${name} ${np} ${nn} ${q}={${polyExpression(vars, coeffs)}}`;
    })
    .join('\n');
}

/** Apply every rewrite (continuations joined first). */
export function convertPspiceCompat(src: string): string {
  return convertPoly(convertVswitch(convertTables(joinContinuations(src))));
}

/**
 * Constructs the engine cannot run after conversion. LAPLACE/FREQ/CHEBYSHEV hang ngspice-45 in
 * the browser; XSPICE `A` instances have no code models in eecircuit-engine.
 */
export function findUnsupportedConstructs(convertedSrc: string): string[] {
  const found = new Set<string>();
  for (const line of convertedSrc.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('*')) continue;
    if (/^[EG]\S*\s+\S+\s+\S+\s+(LAPLACE|FREQ|CHEBYSHEV)\b/i.test(t)) {
      found.add(/LAPLACE|FREQ|CHEBYSHEV/i.exec(t)![0].toUpperCase());
    } else if (/^A\S*\s/i.test(t)) {
      found.add('XSPICE A-device');
    }
  }
  return [...found];
}
