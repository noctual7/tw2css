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
  if (!engine.keyframesGlobal) {
    const used = new Set<string>();
    out.walkDecls(/^animation(-name)?$/, (d) => {
      for (const name of engine.keyframes.keys())
        if (new RegExp(`(^|[\\s,])${name}([\\s,;]|$)`).test(d.value)) used.add(name);
    });
    for (const name of used) out.append(engine.keyframes.get(name)!.clone());
  }
  return out;
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
