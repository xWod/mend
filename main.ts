// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in order, for the `R` output lines of section 2. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- section 3: a file as lines ----------

interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------- section 5: matching lines at three tiers ----------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

interface TierMatch {
  tier: number;
  positions: number[];
}

/** Every occurrence of O in lines, starting at or after `from`, at the first tier that has one. O has at least one line. */
function matchTier(lines: string[], O: string[], strict: boolean, from = 0, endOnly = false): TierMatch | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i += 1) {
      if (endOnly && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (!lineEq(tier, lines[i + j]!, O[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a unified hunk body or a V4A chunk body. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'slash';
  text: string;
  /** Came from a zero-length patch line (an empty context line); dropped at the end of a body. */
  emptyLine: boolean;
}

function oldLines(body: BodyLine[]): string[] {
  return body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
}

/**
 * The lines a matched body writes at `pos`: a context line is the file's own matched line, never the patch's,
 * and at tier 2 every other new line is re-indented from O's first line's indent to the file's.
 */
function newLines(body: BodyLine[], fileLines: string[], pos: number, O: string[], tier: number): string[] {
  const out: string[] = [];
  let o = 0;
  const F = tier === 2 && O.length > 0 ? leadWs(fileLines[pos]!) : '';
  const P = tier === 2 && O.length > 0 ? leadWs(O[0]!) : '';
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + o]!);
      o += 1;
    } else if (b.kind === 'del') {
      o += 1;
    } else if (b.kind === 'add') {
      let t = b.text;
      if (tier === 2 && t !== '' && stripBoth(t) !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

/** True when a `\` line follows the body's last context or `+` line: the result then has no final line break. */
function noBreakAfter(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const k = body[i]!.kind;
    if (k === 'ctx' || k === 'add') return body[i + 1]?.kind === 'slash';
  }
  return false;
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null | undefined; // undefined: no `---` line seen; null: /dev/null
  hdrNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function hdrPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  const fresh = (): USection => ({ gitOld: null, gitNew: null, hdrOld: undefined, hdrNew: undefined, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] });
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && cur.hdrOld === undefined) {
        cur.hdrOld = hdrPath(line.slice(4));
        cur.hdrNew = hdrPath(lines[i + 1]!.slice(4));
      } else {
        cur = fresh();
        cur.hdrOld = hdrPath(line.slice(4));
        cur.hdrNew = hdrPath(lines[i + 1]!.slice(4));
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0 && !line.startsWith('@@')) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') body.push({ kind: 'ctx', text: '', emptyLine: true });
        else if (bl.startsWith(' ')) body.push({ kind: 'ctx', text: bl.slice(1), emptyLine: false });
        else if (bl.startsWith('-')) body.push({ kind: 'del', text: bl.slice(1), emptyLine: false });
        else if (bl.startsWith('+')) body.push({ kind: 'add', text: bl.slice(1), emptyLine: false });
        else if (bl.startsWith('\\')) body.push({ kind: 'slash', text: bl.slice(1), emptyLine: false });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.emptyLine) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    i += 1; // prose and anything else outside bodies is ignored
  }
  return sections;
}

function applyUSection(tree: Tree, s: USection, strict: boolean): void {
  const oldP = s.hdrOld !== undefined ? s.hdrOld : (s.renameFrom ?? s.gitOld);
  const newP = s.hdrNew !== undefined ? s.hdrNew : (s.renameTo ?? s.gitNew);
  if (s.newFile || oldP === null) {
    // A creation: the file is the `+` lines of all its hunks.
    const p = newP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const out: string[] = [];
    let lastBody: BodyLine[] | null = null;
    let lastIdx = -1;
    for (const h of s.hunks) {
      h.body.forEach((b, idx) => {
        if (b.kind === 'add') {
          out.push(b.text);
          lastBody = h.body;
          lastIdx = idx;
        }
      });
    }
    const fin = lastBody !== null && (lastBody as BodyLine[])[lastIdx + 1]?.kind !== 'slash';
    tree.now.set(p, joinFile({ br: '\n', lines: out, final: fin }));
    return;
  }
  if (s.delFile || newP === null) {
    const p = oldP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  const o = oldP;
  const n = newP;
  if (!safe(o)) throw new Fail('unsafe', o);
  if (!safe(n)) throw new Fail('unsafe', n);
  const before = tree.get(o);
  if (before === null) throw new Fail('missing', o);
  if (o !== n && tree.get(n) !== null) throw new Fail('exists', n);
  const f = splitFile(before);
  let d = 0;
  for (const h of s.hunks) {
    const O = oldLines(h.body);
    if (O.length === 0) {
      const ins = h.body.filter((b) => b.kind === 'add').map((b) => b.text);
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...ins);
      if (atEnd) f.final = !noBreakAfter(h.body);
      d += ins.length;
      continue;
    }
    const m = matchTier(f.lines, O, strict);
    if (m === null) throw new Fail('no-match', o);
    const target = h.a - 1 + d;
    let pos = m.positions[0]!;
    for (const p of m.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const N = newLines(h.body, f.lines, pos, O, m.tier);
    const reachesEnd = pos + O.length === f.lines.length;
    f.lines.splice(pos, O.length, ...N);
    if (reachesEnd) f.final = !noBreakAfter(h.body);
    d += N.length - O.length;
  }
  const out = joinFile(f);
  if (o !== n) {
    tree.now.set(n, out);
    tree.now.set(o, null);
    tree.moves.push([o, n]);
  } else {
    tree.now.set(o, out);
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => (tree: Tree) => applyUSection(tree, s, strict));
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

interface SRBlock {
  path: string;
  oldL: string[];
  newL: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldL: lines.slice(i + 1, eq), newL: lines.slice(eq + 1, rep) });
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  return parseSR(lines).map((b) => (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldL.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile({ br: '\n', lines: b.newL, final: true }));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const m = matchTier(f.lines, b.oldL, strict);
    if (m === null) throw new Fail('no-match', p);
    if (m.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = m.positions[0]!;
    const body: BodyLine[] = b.newL.map((t) => ({ kind: 'add', text: t, emptyLine: false }));
    const N = newLines(body, f.lines, pos, b.oldL, m.tier);
    f.lines.splice(pos, b.oldL.length, ...N);
    tree.now.set(p, joinFile(f));
  });
}

// ---------- section 8: V4A patches ----------

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4A(lines: string[]): VSection[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      lastNB = i;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
  const sections: VSection[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(V_ADD)) {
      const sec: VSection = { kind: 'add', path: line.slice(V_ADD.length).trim(), lineNo: i + 1, addLines: [], moveTo: null, chunks: [] };
      i += 1;
      while (i < lastNB && !isStart(lines[i]!)) {
        const bl = lines[i]!;
        if (bl.startsWith('+')) sec.addLines.push(bl.slice(1));
        else if (bl === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (sec.addLines.length > 0 && sec.addLines[sec.addLines.length - 1] === '') sec.addLines.pop();
      sections.push(sec);
      continue;
    }
    if (line.startsWith(V_DEL)) {
      sections.push({ kind: 'del', path: line.slice(V_DEL.length).trim(), lineNo: i + 1, addLines: [], moveTo: null, chunks: [] });
      i += 1;
      continue;
    }
    if (line.startsWith(V_UPD)) {
      const sec: VSection = { kind: 'update', path: line.slice(V_UPD.length).trim(), lineNo: i + 1, addLines: [], moveTo: null, chunks: [] };
      i += 1;
      if (i < lastNB && lines[i]!.startsWith(V_MOVE)) {
        sec.moveTo = lines[i]!.slice(V_MOVE.length).trim();
        i += 1;
      }
      let chunk: VChunk | null = null;
      const flush = (): void => {
        if (chunk !== null) {
          while (chunk.body.length > 0 && chunk.body[chunk.body.length - 1]!.emptyLine) chunk.body.pop();
          sec.chunks.push(chunk);
          chunk = null;
        }
      };
      while (i < lastNB && !isStart(lines[i]!)) {
        const bl = lines[i]!;
        if (bl.startsWith('@@')) {
          flush();
          const anchor = bl.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          i += 1;
          continue;
        }
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
          if (bl === '' || bl === ' ') chunk.body.push({ kind: 'ctx', text: '', emptyLine: true });
          else if (bl.startsWith(' ')) chunk.body.push({ kind: 'ctx', text: bl.slice(1), emptyLine: false });
          else if (bl.startsWith('-')) chunk.body.push({ kind: 'del', text: bl.slice(1), emptyLine: false });
          else chunk.body.push({ kind: 'add', text: bl.slice(1), emptyLine: false });
          i += 1;
          continue;
        }
        if (bl.trim() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
          chunk.eof = true;
          flush();
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineEq(tier, lines[i]!, anchor)) return i;
    }
  }
  return -1;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((s) => (tree: Tree) => {
    const p = s.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile({ br: '\n', lines: s.addLines, final: true }));
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    let dest = p;
    if (s.moveTo !== null) {
      if (!safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      dest = s.moveTo;
    }
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(f.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const O = oldLines(ch.body);
      if (O.length === 0) {
        const ins = ch.body.filter((b) => b.kind === 'add').map((b) => b.text);
        const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const m = matchTier(f.lines, O, strict, cursor, ch.eof);
      if (m === null) throw new Fail('no-match', p);
      const pos = m.positions[0]!;
      const N = newLines(ch.body, f.lines, pos, O, m.tier);
      f.lines.splice(pos, O.length, ...N);
      cursor = pos + N.length;
    }
    const out = joinFile(f);
    if (dest !== p) {
      tree.now.set(dest, out);
      tree.now.set(p, null);
      tree.moves.push([p, dest]);
    } else {
      tree.now.set(p, out);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rowList: { key: string; text: string }[] = [];
  const inR = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (inR.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rowList.push({ key: n, text: `R ${o} -> ${n}` });
      inR.add(o);
      inR.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (inR.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
