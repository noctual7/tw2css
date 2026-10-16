import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Declaration,
  type Document,
  type Root,
} from 'postcss';
import selParser, { type ClassName, type Selector } from 'postcss-selector-parser';
import type { BucketClass } from './analyze.js';
import type { Engine } from './engine.js';

const MARKER = /^(group|peer)(\/.+)?$/;

interface IndexItem {
  order: number;
  owner: string;
  selector: string;
  decls: ChildNode[];
  chain: AtRule[];
}

export interface RuleIndex {
  items: IndexItem[];
  byOwner: Map<string, IndexItem[]>;
  owned: Set<string>;
}

function findOwner(sel: Selector, tokenSet: Set<string>): string | null {
  const c: string[] = [];
  sel.walkClasses((n) => {
    if (tokenSet.has(n.value) && !MARKER.test(n.value)) c.push(n.value);
  });
  if (!c.length) return null;
  if (c.length > 1) return c.find((v) => v !== 'dark') || c[0];
  return c[0];
}

/** Индекс правил Tailwind: каждый селектор -> «владелец» (класс-утилита) */
export function buildIndex(root: Root, tokenSet: Set<string>): RuleIndex {
  const items: IndexItem[] = [];
  const byOwner = new Map<string, IndexItem[]>();
  let order = 0;
  root.walkRules((rule) => {
    if (rule.parent && rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    const chain: AtRule[] = [];
    let p: Container | Document | undefined = rule.parent;
    while (p && p.type !== 'root') {
      chain.unshift(p as AtRule);
      p = p.parent;
    }
    const ast = selParser().astSync(rule.selector);
    ast.each((sel) => {
      const owner = findOwner(sel as Selector, tokenSet);
      if (owner == null) return;
      const item: IndexItem = { order: order++, owner, selector: sel.toString().trim(), decls: rule.nodes, chain };
      items.push(item);
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner)!.push(item);
    });
  });
  return { items, byOwner, owned: new Set(byOwner.keys()) };
}

function rewriteSelector(selector: string, owner: string, local: string): string {
  return selParser((root) => {
    const list: ClassName[] = [];
    root.walkClasses((c) => {
      list.push(c);
    });
    for (const c of list) {
      if (c.value === owner) {
        const raw = c as ClassName & { raws?: { value?: unknown } };
        if (raw.raws) delete raw.raws.value;
        c.value = local;
      } else {
        // внешние классы (dark, group, peer …) остаются глобальными
        const s = selParser.selector({ value: '' });
        s.append(selParser.className({ value: c.value }));
        c.replaceWith(selParser.pseudo({ value: ':global', nodes: [s] }));
      }
    }
  }).processSync(selector);
}

function pushMerged(container: Container, node: ChildNode): void {
  const last = container.last;
  if (
    node.type === 'atrule' &&
    node.nodes &&
    last &&
    last.type === 'atrule' &&
    last.name === node.name &&
    last.params === node.params
  ) {
    node.each((c) => pushMerged(last, c.clone()));
  } else container.append(node);
}

interface Entry {
  selector: string;
  chainKey: string;
  chain: AtRule[];
  decls: Declaration[];
  fams: Set<string>;
}

/** groups: классы, которые могут оказаться на одном элементе */
export function buildModuleCss(groups: BucketClass[][], index: RuleIndex, engine: Engine): Root {
  const out = postcss.root();
  groups.forEach((grp, gi) => {
    const byToken = new Map<string, string[]>();
    for (const c of grp)
      for (const t of c.tokens) {
        if (!byToken.has(t)) byToken.set(t, []);
        byToken.get(t)!.push(c.name);
      }
    const items: IndexItem[] = [];
    for (const t of byToken.keys()) items.push(...(index.byOwner.get(t) || []));
    items.sort((a, b) => a.order - b.order);
    // склеиваем правила с одинаковым селектором, если между ними нет конфликтующих свойств
    const entries: Entry[] = [];
    const family = (prop: string): string =>
      prop.startsWith('--') ? prop : prop.replace(/^-\w+-/, '').split('-')[0];
    for (const it of items) {
      for (const name of byToken.get(it.owner)!) {
        const selector = rewriteSelector(it.selector, it.owner, name);
        const chainKey = it.chain.map((c) => `${c.name} ${c.params}`).join('|');
        const decls = it.decls.filter((d): d is Declaration => d.type === 'decl');
        const fams = new Set(decls.map((d) => family(d.prop)));
        let target: Entry | null = null;
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e.selector === selector && e.chainKey === chainKey) {
            target = e;
            break;
          }
          if ([...e.fams].some((f) => fams.has(f))) break;
        }
        if (target) {
          target.decls.push(...decls);
          decls.forEach((d) => target!.fams.add(family(d.prop)));
        } else entries.push({ selector, chainKey, chain: it.chain, decls: [...decls], fams });
      }
    }
    const holder = postcss.root();
    for (const e of entries) {
      const rule = postcss.rule({ selector: e.selector });
      e.decls.forEach((d) => rule.append(d.clone()));
      let node: ChildNode = rule;
      for (let i = e.chain.length - 1; i >= 0; i--) {
        const w = postcss.atRule({ name: e.chain[i].name, params: e.chain[i].params });
        w.append(node);
        node = w;
      }
      pushMerged(holder, node);
    }
    holder.each((n: ChildNode) => {
      const c = n.clone();
      if (gi > 0 && n === holder.first) c.raws.before = '\n\n';
      out.append(c);
    });
  });
  const vars = collectVars(engine);
  inlineVars(out, vars);
  dropDuplicateDecls(out);
  dropUnusedCustomProps(out);
  pruneEmpty(out);
  if (engine.keyframes.size) {
    const used = new Set<string>();
    out.walkDecls(/^animation(-name)?$/, (d) => {
      for (const name of engine.keyframes.keys())
        if (new RegExp(`(^|[\\s,])${name}([\\s,;]|$)`).test(d.value)) used.add(name);
    });
    for (const name of used) out.append(engine.keyframes.get(name)!.clone());
  }
  return out;
}

/** Значения CSS-переменных Tailwind (тема, `--tw-*`, `@property`): имя → значение */
export function collectVars(engine: Engine): Map<string, string> {
  const vars = new Map<string, string>();
  engine.globals.walkDecls((d) => {
    if (!d.prop.startsWith('--')) return;
    const v = d.value.trim();
    // `initial` превращает переменную в guaranteed-invalid, поэтому срабатывает fallback
    if (v === 'initial') return;
    vars.set(d.prop, v);
  });
  return vars;
}

function splitVar(inner: string): [string, string | null] {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) return [inner.slice(0, i), inner.slice(i + 1)];
  }
  return [inner, null];
}

function findVars(value: string): { start: number; end: number; inner: string }[] {
  const out: { start: number; end: number; inner: string }[] = [];
  let i = 0;
  for (;;) {
    const j = value.indexOf('var(', i);
    if (j < 0) break;
    let depth = 0;
    let k = j + 3;
    for (; k < value.length; k++) {
      if (value[k] === '(') depth++;
      else if (value[k] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (k >= value.length) break;
    out.push({ start: j, end: k + 1, inner: value.slice(j + 4, k) });
    i = k + 1;
  }
  return out;
}

function resolveValue(
  value: string,
  locals: Map<string, string>,
  globals: Map<string, string>,
  stack: Set<string>,
): string {
  const vars = findVars(value);
  if (!vars.length) return value;
  let out = '';
  let pos = 0;
  for (const v of vars) {
    out += value.slice(pos, v.start);
    const [nameRaw, fb] = splitVar(v.inner);
    const name = nameRaw.trim();
    let replacement: string | null = null;
    if (stack.has(name)) {
      if (fb !== null) replacement = resolveValue(fb, locals, globals, stack);
    } else {
      const defined = locals.has(name) ? locals.get(name) : globals.get(name);
      if (defined !== undefined) {
        stack.add(name);
        replacement = resolveValue(defined, locals, globals, stack);
        stack.delete(name);
      } else if (fb !== null) {
        stack.add(name);
        replacement = resolveValue(fb, locals, globals, stack);
        stack.delete(name);
      }
    }
    out += replacement === null ? value.slice(v.start, v.end) : replacement;
    pos = v.end;
  }
  return (out + value.slice(pos)).replace(/[ \t]{2,}/g, ' ').trim();
}

/** Подставляет значения переменных прямо в правила (переменные в итоговом CSS не остаются) */
export function inlineVars(root: Root, globals: Map<string, string>): void {
  root.walkRules((rule) => {
    if (rule.parent && rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    const locals = new Map<string, string>();
    rule.walkDecls(/^--/, (d) => {
      const v = d.value.trim();
      if (v !== 'initial') locals.set(d.prop, v);
    });
    if (!locals.size && !globals.size) return;
    rule.walkDecls((d) => {
      const loc = d.prop.startsWith('--') ? new Map(locals) : locals;
      if (d.prop.startsWith('--')) loc.delete(d.prop);
      const next = resolveValue(d.value, loc, globals, new Set());
      if (next !== d.value) d.value = next;
    });
  });
}

/** Убирает одинаковые пары свойство/значение, оставляя последнее объявление */
export function dropDuplicateDecls(root: Root): void {
  root.walkRules((rule) => {
    const decls: Declaration[] = [];
    rule.each((n) => {
      if (n.type === 'decl') decls.push(n);
    });
    decls.forEach((d, i) => {
      if (decls.slice(i + 1).some((x) => x.prop === d.prop && x.value === d.value)) d.remove();
    });
  });
}

/** Удаляет правила и @-правила, оставшиеся без объявлений после подстановки переменных */
export function pruneEmpty(root: Root): void {
  const clean = (container: Container): void => {
    container.each((n) => {
      if (n.type === 'atrule' && n.nodes) {
        clean(n);
        if (!n.nodes.length) n.remove();
      } else if (n.type === 'rule' && (!n.nodes || !n.nodes.length)) n.remove();
    });
  };
  clean(root);
}

/** Убирает объявления `--x: …`, на которые больше не ссылается ни один `var()` */
export function dropUnusedCustomProps(root: Root): void {
  const used = new Set<string>();
  root.walkDecls((d) => {
    if (!d.value) return;
    for (const v of findVars(d.value)) used.add(splitVar(v.inner)[0].trim());
  });
  root.walkDecls(/^--/, (d) => {
    if (!used.has(d.prop)) d.remove();
  });
}

function fmt(node: ChildNode, ind = ''): string {
  switch (node.type) {
    case 'decl':
      return `${ind}${node.prop}: ${node.value}${node.important ? ' !important' : ''};\n`;
    case 'rule': {
      const body = node.nodes.map((n) => fmt(n, ind + '  ')).join('');
      return `${ind}${node.selector.replace(/\s*\n\s*/g, ' ')} {\n${body}${ind}}\n`;
    }
    case 'atrule': {
      const head = `@${node.name}${node.params ? ' ' + node.params.replace(/\s*\n\s*/g, ' ') : ''}`;
      if (!node.nodes) return `${ind}${head};\n`;
      const body = node.nodes.map((n) => fmt(n, ind + '  ')).join('');
      return `${ind}${head} {\n${body}${ind}}\n`;
    }
    default:
      return '';
  }
}

export const fmtRoot = (root: Root): string =>
  root.nodes
    .map((n) => fmt(n))
    .filter(Boolean)
    .join('\n');
