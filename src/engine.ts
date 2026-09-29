import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import fg from 'fast-glob';
import postcss, { type AtRule, type Root } from 'postcss';
import type { RunOptions } from './types.js';

export interface Engine {
  major: number;
  version: string;
  utilities: Root;
  globals: Root;
  preflight: Root | null;
  keyframes: Map<string, AtRule>;
  keyframesGlobal: boolean;
}

interface Tailwind {
  req: NodeJS.Require;
  major: number;
  version: string;
}

type Generated = Omit<Engine, 'version'>;

const projectRequire = (cwd: string): NodeJS.Require => createRequire(path.join(cwd, '__tw2cssm__.js'));

function findFirst(cwd: string, names: string[]): string | null {
  for (const n of names) {
    const p = path.join(cwd, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function detectTailwind(cwd: string): Tailwind | null {
  const req = projectRequire(cwd);
  try {
    const pkg = req('tailwindcss/package.json') as { version: string };
    return { req, major: parseInt(pkg.version, 10), version: pkg.version };
  } catch {
    try {
      let dir = path.dirname(req.resolve('tailwindcss'));
      for (;;) {
        const pj = path.join(dir, 'package.json');
        if (fs.existsSync(pj)) {
          const pkg = JSON.parse(fs.readFileSync(pj, 'utf8')) as { name?: string; version: string };
          if (pkg.name === 'tailwindcss') return { req, major: parseInt(pkg.version, 10), version: pkg.version };
        }
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
      }
    } catch {
      return null;
    }
  }
}

const isDefaultsRule = (r: { selector: string }): boolean =>
  /(^|,)\s*(\*|::backdrop)/.test(r.selector) && !/\.[\w\\-]/.test(r.selector);

function corePlugins(cp: unknown, preflight: boolean): unknown {
  if (Array.isArray(cp)) return preflight ? [...new Set([...cp, 'preflight'])] : cp.filter((x) => x !== 'preflight');
  return { ...((cp as Record<string, unknown>) || {}), preflight };
}

async function genV3(tokens: string[], opts: RunOptions, tw: Tailwind): Promise<Generated> {
  const tailwind = tw.req('tailwindcss');
  const cfgPath = opts.config
    ? path.resolve(opts.cwd, opts.config)
    : findFirst(opts.cwd, [
        'tailwind.config.js',
        'tailwind.config.cjs',
        'tailwind.config.mjs',
        'tailwind.config.ts',
      ]);
  let cfg: Record<string, unknown> = {};
  if (cfgPath) cfg = { ...(tw.req('tailwindcss/loadConfig')(cfgPath) as Record<string, unknown>) };

  const run = async (raw: string, preflight: boolean, css: string): Promise<string> => {
    const config = {
      ...cfg,
      content: [{ raw, extension: 'html' }],
      corePlugins: corePlugins(cfg.corePlugins, preflight),
    };
    return (await postcss([tailwind(config)]).process(css, { from: undefined })).css;
  };

  const root = postcss.parse(await run(tokens.join(' '), false, '@tailwind base;\n@tailwind utilities;'));
  const utilities = postcss.root();
  const globals = postcss.root();
  const keyframes = new Map<string, AtRule>();
  root.each((node) => {
    if (node.type === 'atrule' && /keyframes$/.test(node.name)) keyframes.set(node.params, node.clone());
    else if (node.type === 'rule' && isDefaultsRule(node)) globals.append(node.clone());
    else utilities.append(node.clone());
  });

  let preflight: Root | null = null;
  if (opts.preflight) {
    const all = postcss.parse(await run('', true, '@tailwind base;'));
    preflight = postcss.root();
    all.each((n) => {
      if (!(n.type === 'rule' && isDefaultsRule(n))) preflight!.append(n.clone());
    });
  }
  return { major: 3, utilities, globals, preflight, keyframes, keyframesGlobal: false };
}

function detectV4Css(cwd: string, explicit?: string): string | null {
  if (explicit) return path.resolve(cwd, explicit);
  const files = fg.sync(['{src,app,styles,pages}/**/*.css', '*.css'], {
    cwd,
    absolute: true,
    ignore: ['**/node_modules/**', '**/*.module.css'],
  });
  return files.find((f) => /@import\s+["']tailwindcss/.test(fs.readFileSync(f, 'utf8'))) || null;
}

async function genV4(tokens: string[], opts: RunOptions, tw: Tailwind): Promise<Generated> {
  let node: typeof import('@tailwindcss/node');
  try {
    node = tw.req('@tailwindcss/node') as typeof import('@tailwindcss/node');
  } catch {
    node = await import('@tailwindcss/node');
  }
  const cssFile = detectV4Css(opts.cwd, opts.css);
  let css = cssFile ? fs.readFileSync(cssFile, 'utf8') : '@import "tailwindcss";';
  // не сканируем проект: кандидаты передаём явно
  css = css.replace(
    /@import\s+(["'])tailwindcss\1([^;]*);/,
    (m, q: string, rest: string) => (/source\(/.test(rest) ? m : `@import ${q}tailwindcss${q} source(none)${rest};`),
  );
  const compiler = await node.compile(css, {
    base: cssFile ? path.dirname(cssFile) : opts.cwd,
    onDependency() {},
  });
  const built = compiler.build(tokens);
  const opt: unknown = node.optimize(built, { file: 'tw2cssm.css', minify: false });
  const root = postcss.parse(typeof opt === 'string' ? opt : String((opt as { code: unknown }).code));

  const utilities = postcss.root();
  const globals = postcss.root();
  const preflight = postcss.root();
  root.each((n) => {
    if (n.type !== 'atrule') return;
    if (n.name === 'layer') {
      if (!n.nodes) return;
      if (n.params === 'utilities')
        n.each((c) => {
          utilities.append(c.clone());
        });
      else if (n.params === 'base') {
        if (opts.preflight) preflight.append(n.clone({ params: 'base' }));
      } else if (n.params === 'theme' || n.params === 'properties') globals.append(n.clone());
    } else if (n.name === 'property' || /keyframes$/.test(n.name)) globals.append(n.clone());
  });
  return {
    major: 4,
    utilities,
    globals,
    preflight: opts.preflight ? preflight : null,
    keyframes: new Map(),
    keyframesGlobal: true,
  };
}

export async function generate(tokens: string[], opts: RunOptions): Promise<Engine> {
  const tw = detectTailwind(opts.cwd);
  if (!tw)
    throw new Error(
      'tailwindcss не найден в проекте. Установите его (npm i -D tailwindcss) и запустите команду из корня проекта.',
    );
  const res = tw.major >= 4 ? await genV4(tokens, opts, tw) : await genV3(tokens, opts, tw);
  return { ...res, version: tw.version };
}
