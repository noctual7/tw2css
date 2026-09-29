import { parse as babelParse, type ParseResult } from '@babel/parser';
// @babel/traverse — CommonJS: в ESM-сборке функция лежит в `default` у module.exports
import babelTraverse, { type NodePath } from '@babel/traverse';
import type {
  CallExpression,
  File,
  JSXAttribute,
  JSXOpeningElement,
  Node,
  ObjectMethod,
  ObjectProperty,
  TemplateElement,
} from '@babel/types';
import MagicString from 'magic-string';

const CLASS_FUNCS = new Set(['clsx', 'cn', 'cx', 'classnames', 'classNames', 'twMerge', 'twJoin']);
const VARIANT_FUNCS = new Set(['cva']);
const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await async'.split(
    ' ',
  ),
);
const TAGS: Record<string, string> = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  p: 'text',
  a: 'link',
  img: 'image',
  ul: 'list',
  ol: 'list',
  li: 'item',
  div: 'box',
  span: 'label',
};

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function camel(s: string): string {
  const parts = String(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let r = parts.map((p, i) => (i ? cap(p) : p[0].toLowerCase() + p.slice(1))).join('');
  if (!r) r = 'cls';
  if (/^\d/.test(r)) r = '_' + r;
  return RESERVED.has(r) ? r + '_' : r;
}

type TraverseFn = typeof import('@babel/traverse').default;

const traverse: TraverseFn = (babelTraverse as unknown as { default: TraverseFn }).default;

export type ParsedFile = ParseResult<File>;

export function parse(code: string, file: string): ParsedFile {
  const plugins: ('jsx' | 'typescript')[] = ['jsx'];
  if (/\.tsx?$/.test(file)) plugins.push('typescript');
  return babelParse(code, { sourceType: 'module', plugins, errorRecovery: true });
}

export interface BucketClass {
  name: string;
  tokens: string[];
}

export interface Registration {
  known: Set<string>;
  ref: string;
}

export class Bucket {
  id: number;
  key: string;
  classes: BucketClass[] = [];
  byKey = new Map<string, BucketClass>();
  names = new Set<string>();
  gids = new Map<number, Set<BucketClass>>();
  rootSite: unknown = null;
  firstComp: string | null | undefined;
  roots: Map<string | null, number> | undefined;
  cssName = '';
  importName = '';

  constructor(id: number, key: string) {
    this.id = id;
    this.key = key;
  }

  register(tokens: string[], base: string, hint: string | null, gid: number): string {
    const key = [...tokens].sort().join(' ');
    let cls = this.byKey.get(key);
    if (!cls) {
      const name = camel(base) + (hint ? cap(camel(hint)) : '');
      let n = name;
      let i = 2;
      while (this.names.has(n)) n = name + i++;
      this.names.add(n);
      cls = { name: n, tokens: [...tokens] };
      this.classes.push(cls);
      this.byKey.set(key, cls);
    }
    if (!this.gids.has(gid)) this.gids.set(gid, new Set());
    this.gids.get(gid)!.add(cls);
    return cls.name;
  }

  /** классы, которые могут оказаться на одном элементе, объединяем для сохранения порядка каскада */
  groups(): BucketClass[][] {
    const idx = new Map(this.classes.map((c, i): [BucketClass, number] => [c, i]));
    const parent = this.classes.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const set of this.gids.values()) {
      const a = [...set].map((c) => idx.get(c)!);
      for (let i = 1; i < a.length; i++) parent[find(a[i])] = find(a[0]);
    }
    const m = new Map<number, BucketClass[]>();
    this.classes.forEach((c, i) => {
      const r = find(i);
      if (!m.has(r)) m.set(r, []);
      m.get(r)!.push(c);
    });
    return [...m.values()];
  }
}

function hintOf(n: Node | null | undefined): string | null {
  if (!n) return null;
  switch (n.type) {
    case 'Identifier':
      return n.name;
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return !n.computed && n.property.type === 'Identifier' ? n.property.name : null;
    case 'UnaryExpression': {
      const h = n.operator === '!' ? hintOf(n.argument) : null;
      return h ? 'not' + cap(h) : null;
    }
    case 'BinaryExpression': {
      const l = hintOf(n.left);
      if (l && n.right.type === 'StringLiteral' && /^[!=]=/.test(n.operator))
        return l + (n.operator[0] === '!' ? 'Not' : '') + cap(camel(n.right.value));
      return l;
    }
    case 'LogicalExpression':
      return hintOf(n.right) || hintOf(n.left);
    default:
      return null;
  }
}

const neg = (h: string | null): string | null => (h ? 'not' + cap(h) : null);
const esc = (s: string): string => s.replace(/[\\`$]/g, '\\$&');
const calleeName = (c: CallExpression['callee']): string | null =>
  c.type === 'Identifier'
    ? c.name
    : c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier'
      ? c.property.name
      : null;

function declaredName(p: NodePath): string | null {
  const id = (p.node as { id?: { name?: string } | null }).id;
  return id && typeof id.name === 'string' ? id.name : null;
}

function componentName(path: NodePath): string | null {
  for (let p: NodePath | null = path.parentPath; p; p = p.parentPath) {
    let name: string | null = null;
    if ((p.isFunctionDeclaration() || p.isClassDeclaration()) && p.node.id) name = p.node.id.name;
    else if (p.isFunctionExpression() || p.isArrowFunctionExpression() || p.isClassExpression()) {
      name = declaredName(p);
      if (!name) {
        let q: NodePath | null = p.parentPath;
        while (q && q.isCallExpression()) q = q.parentPath;
        if (q && q.isVariableDeclarator() && q.node.id.type === 'Identifier') name = q.node.id.name;
      }
    }
    if (name && /^[A-Z]/.test(name)) return name;
  }
  return null;
}

function tagOf(opening: JSXOpeningElement): string {
  const n = opening.name;
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXMemberExpression') return n.property.name;
  return 'element';
}

export interface SiteBase {
  id: number;
  comp: string | null;
}

export interface AttrSite extends SiteBase {
  kind: 'attr';
  node: JSXAttribute;
  tag: string;
}

export interface CallSite extends SiteBase {
  kind: 'call';
  node: CallExpression;
  varName: string | null;
}

export type Site = AttrSite | CallSite;

/** Фаза 1: найти все места с классами */
export function findSites(ast: File): Site[] {
  const sites: Site[] = [];
  const isClassAttr = (p: NodePath): boolean =>
    p.isJSXAttribute() && p.node.name.type === 'JSXIdentifier' && p.node.name.name === 'className';
  const isFn = (p: NodePath): boolean => {
    if (!p.isCallExpression()) return false;
    const name = calleeName(p.node.callee);
    return !!name && (CLASS_FUNCS.has(name) || VARIANT_FUNCS.has(name));
  };
  traverse(ast, {
    JSXAttribute(path) {
      const node = path.node;
      if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'className' || !node.value) return;
      sites.push({
        id: sites.length,
        kind: 'attr',
        node,
        comp: componentName(path),
        tag: tagOf(path.parent as JSXOpeningElement),
      });
    },
    CallExpression(path) {
      const name = calleeName(path.node.callee);
      if (!name || (!CLASS_FUNCS.has(name) && !VARIANT_FUNCS.has(name))) return;
      if (path.findParent((p) => isClassAttr(p) || isFn(p))) return;
      const parent = path.parentPath;
      const decl = parent.isVariableDeclarator() && parent.node.id.type === 'Identifier' ? parent.node.id.name : null;
      sites.push({ id: sites.length, kind: 'call', node: path.node, comp: componentName(path), varName: decl });
    },
  });
  return sites;
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Env {
  apply: boolean;
  isKnown: (token: string) => boolean;
  tokens: Set<string>;
  edits: Edit[];
  site: Site;
  cva: Set<string>;
  bucket: Bucket | null;
  warn: (node: Node, message: string) => void;
}

interface Ctx {
  attr?: boolean;
}

function convert(node: Node | null | undefined, env: Env, hint: string | null, ctx?: Ctx): void {
  if (!node) return;
  switch (node.type) {
    case 'StringLiteral': {
      const n = node;
      const tokens = n.value.split(/\s+/).filter(Boolean);
      const reg = tokens.length ? register(env, tokens, hint) : null;
      if (reg) {
        const e = render(tokens, reg);
        env.edits.push({ start: n.start!, end: n.end!, text: ctx && ctx.attr ? `{${e}}` : e });
      }
      return;
    }
    case 'TemplateLiteral': {
      const tl = node;
      const quasis = tl.quasis;
      const parts: { q: TemplateElement; ms: { index: number; text: string }[]; text: string }[] = [];
      const all: string[] = [];
      quasis.forEach((q, i) => {
        const text = q.value.raw;
        const re = /\S+/g;
        const ms: { index: number; text: string }[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const glued = (m.index === 0 && i > 0) || (m.index + m[0].length === text.length && i < quasis.length - 1);
          if (glued || m[0].includes('\\')) continue;
          ms.push({ index: m.index, text: m[0] });
          all.push(m[0]);
        }
        parts.push({ q, ms, text });
      });
      const reg = all.length ? register(env, all, hint) : null;
      if (reg) {
        let done = false;
        for (const { q, ms, text } of parts) {
          const rem = ms.filter((x) => reg.known.has(x.text));
          if (!rem.length) continue;
          let out = '';
          let pos = 0;
          for (const x of rem) {
            out += text.slice(pos, x.index);
            if (!done) {
              out += '${' + reg.ref + '}';
              done = true;
            }
            pos = x.index + x.text.length;
          }
          let t = (out + text.slice(pos)).replace(/ {2,}/g, ' ');
          if (q === quasis[quasis.length - 1]) t = t.trimEnd();
          if (q === quasis[0]) t = t.trimStart();
          env.edits.push({ start: q.start!, end: q.end!, text: t });
        }
      }
      tl.expressions.forEach((e) => convert(e, env, null));
      return;
    }
    case 'JSXExpressionContainer':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return convert(node.expression, env, hint);
    case 'ConditionalExpression': {
      const n = node;
      const h = hintOf(n.test);
      convert(n.consequent, env, h || hint);
      convert(n.alternate, env, neg(h));
      return;
    }
    case 'LogicalExpression': {
      const n = node;
      if (n.operator === '&&') return convert(n.right, env, hintOf(n.left) || hint);
      convert(n.left, env, hint);
      convert(n.right, env, hint);
      return;
    }
    case 'ArrayExpression':
      node.elements.forEach((e) => e && convert(e, env, hint));
      return;
    case 'ObjectExpression':
      for (const p of node.properties) {
        if (p.type !== 'ObjectProperty' || p.shorthand) continue;
        const prop = p as ObjectProperty;
        const h = hintOf(prop.value);
        if (prop.computed) {
          if (prop.key.type === 'StringLiteral') convert(prop.key, env, h);
          continue;
        }
        const str =
          prop.key.type === 'StringLiteral' ? prop.key.value : prop.key.type === 'Identifier' ? prop.key.name : null;
        const tokens = str ? str.split(/\s+/).filter(Boolean) : [];
        const reg = tokens.length ? register(env, tokens, h) : null;
        if (reg) env.edits.push({ start: prop.key.start!, end: prop.key.end!, text: `[${render(tokens, reg)}]` });
      }
      return;
    case 'CallExpression': {
      const n = node;
      const name = calleeName(n.callee);
      if (name && CLASS_FUNCS.has(name)) n.arguments.forEach((a) => convert(a, env, null));
      else if (name && VARIANT_FUNCS.has(name)) convertCva(n, env);
      else if (!name || !env.cva.has(name)) env.warn(n, 'вызов функции в className не преобразован');
      return;
    }
    case 'Identifier':
      if (node.name !== 'undefined') env.warn(node, `динамический класс «${node.name}» не преобразован`);
      return;
    default:
  }
}

function keyName(p: ObjectProperty | ObjectMethod): string | null {
  if (p.computed) return null;
  const k = p.key;
  if (k.type === 'Identifier') return k.name;
  if (k.type === 'StringLiteral') return k.value;
  return String((k as unknown as { value?: unknown }).value);
}

function convertCva(node: CallExpression, env: Env): void {
  const [base, cfg] = node.arguments;
  convert(base, env, 'base');
  if (!cfg || cfg.type !== 'ObjectExpression') return;
  for (const p of cfg.properties) {
    if (p.type !== 'ObjectProperty') continue;
    const k = keyName(p);
    if (k === 'variants' && p.value.type === 'ObjectExpression') {
      for (const g of p.value.properties) {
        if (g.type !== 'ObjectProperty' || g.value.type !== 'ObjectExpression') continue;
        for (const o of g.value.properties)
          if (o.type === 'ObjectProperty') convert(o.value, env, `${keyName(g)}-${keyName(o)}`);
      }
    } else if (k === 'compoundVariants' && p.value.type === 'ArrayExpression') {
      p.value.elements.forEach((el, i) => {
        if (!el || el.type !== 'ObjectExpression') return;
        for (const q of el.properties)
          if (q.type === 'ObjectProperty' && ['class', 'className'].includes(keyName(q) ?? ''))
            convert(q.value, env, `compound${i + 1}`);
      });
    }
  }
}

function register(env: Env, tokens: string[], hint: string | null): Registration | null {
  for (const t of tokens) env.tokens.add(t);
  if (!env.apply) return null;
  const known = [...new Set(tokens.filter((t) => env.isKnown(t)))];
  if (!known.length) return null;
  const b = env.bucket!;
  let base: string;
  if (env.site.kind === 'attr') {
    const comp = env.site.comp;
    if (b.firstComp === undefined) b.firstComp = comp;
    if (!b.roots) b.roots = new Map();
    if (!b.roots.has(comp)) b.roots.set(comp, env.site.id);
    if (b.roots.get(comp) === env.site.id)
      base = !comp || comp === b.firstComp ? 'root' : comp[0].toLowerCase() + comp.slice(1) + 'Root';
    else base = TAGS[env.site.tag] || env.site.tag;
  } else base = (env.site.varName || 'classes').replace(/Variants?$/, '') || 'cva';
  // для cva имя строится из подсказки: buttonBase, buttonSizeSm…
  const name = b.register(known, base, hint, env.site.id);
  return { known: new Set(known), ref: `@@S${b.id}@@.${name}` };
}

function render(tokens: string[], reg: Registration): string {
  const unknown = [...new Set(tokens.filter((t) => !reg.known.has(t)))];
  return unknown.length ? '`${' + reg.ref + '} ' + esc(unknown.join(' ')) + '`' : reg.ref;
}

export interface ProcessOptions {
  apply: boolean;
  isKnown?: (token: string) => boolean;
  getBucket?: (comp: string | null) => Bucket;
  file: string;
}

export interface ProcessResult {
  tokens: Set<string>;
  edits: Edit[];
  warnings: string[];
}

/** Фаза 2: применить (apply=false — только собрать токены) */
export function processSites(sites: Site[], { apply, isKnown, getBucket, file }: ProcessOptions): ProcessResult {
  const tokens = new Set<string>();
  const edits: Edit[] = [];
  const warnings: string[] = [];
  const cva = new Set(
    sites
      .filter((s): s is CallSite => s.kind === 'call' && VARIANT_FUNCS.has(calleeName(s.node.callee) ?? '') && !!s.varName)
      .map((s) => s.varName!),
  );
  for (const site of sites) {
    const env: Env = {
      apply,
      isKnown: isKnown ?? (() => false),
      tokens,
      edits,
      site,
      cva,
      bucket: apply && getBucket ? getBucket(site.comp) : null,
      warn: (n, msg) => warnings.push(`${file}:${n.loc ? n.loc.start.line : '?'} ${msg}`),
    };
    if (site.kind === 'attr') {
      const v = site.node.value;
      if (v && v.type === 'StringLiteral') convert(v, env, null, { attr: true });
      else convert(v, env, null);
    } else convert(site.node, env, null);
  }
  return { tokens, edits, warnings };
}

export interface InsertPosition {
  pos: number;
  q: string;
  semi: boolean;
  prefix: string;
  suffix?: string;
}

export function insertPosition(ast: File, code: string): InsertPosition {
  const imports = ast.program.body.filter((n) => n.type === 'ImportDeclaration');
  const last = imports[imports.length - 1];
  const dirs = ast.program.directives || [];
  const q = imports.length ? code[imports[0].source.start!] : "'";
  const semi = imports.length ? code.slice(0, last.end!).endsWith(';') : true;
  if (last) return { pos: last.end!, q, semi, prefix: '\n' };
  if (dirs.length) return { pos: dirs[dirs.length - 1].end!, q, semi, prefix: '\n\n' };
  return { pos: 0, q, semi, prefix: '', suffix: '\n' };
}

export interface ImportLines {
  pos: number;
  text: string;
}

export function applyEdits(code: string, edits: Edit[], importLines?: ImportLines): MagicString {
  const s = new MagicString(code);
  for (const e of edits) s.overwrite(e.start, e.end, e.text);
  if (importLines) s.appendRight(importLines.pos, importLines.text);
  return s;
}
