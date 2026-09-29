import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import * as A from './analyze.js';
import { generate } from './engine.js';
import { buildIndex, buildModuleCss, fmtRoot } from './css.js';
import type { RunOptions } from './types.js';

const MARK = '/* Сгенерировано tw2cssm из классов Tailwind */';
const log = (...a: unknown[]): void => console.log(...a);
const rel = (cwd: string, p: string): string => path.relative(cwd, p) || '.';

interface Write {
  path: string;
  text: string;
}

export async function run(opts: RunOptions): Promise<void> {
  const cwd = opts.cwd;
  const targets = opts.paths.length ? opts.paths : ['.'];
  const patterns = targets.map((t) => {
    const p = path.resolve(cwd, t);
    return fs.existsSync(p) && fs.statSync(p).isDirectory() ? `${t.replace(/\\/g, '/')}/**/*.{js,jsx,ts,tsx}` : t;
  });
  const files = await fg(patterns, {
    cwd,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/*.d.ts', ...opts.ignore],
  });

  log(`Просмотр: ${targets.join(', ')} — найдено файлов js/jsx/ts/tsx: ${files.length}`);
  // Фаза 1: разбор и сбор токенов
  const parsed: { file: string; code: string; ast: A.ParsedFile; sites: A.Site[] }[] = [];
  const allTokens = new Set<string>();
  const warnings: string[] = [];
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    if (!/className|\b(clsx|cn|cx|classnames|classNames|twMerge|twJoin|cva)\s*\(/.test(code)) continue;
    let ast: A.ParsedFile;
    try {
      ast = A.parse(code, file);
    } catch (e) {
      warnings.push(`${rel(cwd, file)}: не удалось разобрать (${(e as Error).message})`);
      continue;
    }
    const sites = A.findSites(ast);
    if (!sites.length) continue;
    const { tokens } = A.processSites(sites, { apply: false, file: rel(cwd, file) });
    tokens.forEach((t) => allTokens.add(t));
    parsed.push({ file, code, ast, sites });
  }
  if (!parsed.length) {
    log('Ничего не найдено: нет className/clsx/cn в просмотренных файлах.');
    if (!files.length)
      log('Ни одного файла js/jsx/ts/tsx не найдено — проверьте папку запуска или передайте путь: npx tw2cssm ./app ./components');
    warnings.forEach((x) => log('  ⚠ ' + x));
    return;
  }

  // Фаза 2: Tailwind генерирует CSS для всех найденных классов
  const engine = await generate([...allTokens], opts);
  log(`Tailwind v${engine.version}, уникальных классов: ${allTokens.size}`);
  const index = buildIndex(engine.utilities, allTokens);

  // Фаза 3: переписываем файлы и создаём модули
  const writes: Write[] = [];
  let needGlobals = !!engine.preflight;
  let changedFiles = 0;
  let modules = 0;

  for (const f of parsed) {
    const relFile = rel(cwd, f.file);
    const base = path.basename(f.file).replace(/\.[^.]+$/, '');
    const buckets = new Map<string, A.Bucket>();
    const getBucket = (): A.Bucket => {
      const key = base; // один модуль на файл
      if (!buckets.has(key)) buckets.set(key, new A.Bucket(buckets.size, key));
      return buckets.get(key)!;
    };
    const { edits, warnings: w } = A.processSites(f.sites, {
      apply: true,
      isKnown: (t) => index.owned.has(t),
      getBucket,
      file: relFile,
    });
    warnings.push(...w);
    const used = [...buckets.values()].filter((b) => b.classes.length);
    if (!edits.length || !used.length) continue;

    const single = used.length === 1;
    const dir = path.dirname(f.file);
    const scope = new Set<string>();
    f.ast.program.body.forEach((n) => {
      const ids = n.type === 'ImportDeclaration' ? n.specifiers.map((s) => s.local.name) : [];
      ids.forEach((i) => scope.add(i));
    });
    const cssFiles: Write[] = [];
    let skip = false;
    for (const b of used) {
      b.cssName = `${single ? base : b.key}.module.css`;
      let imp = single ? 'styles' : `${b.key[0].toLowerCase()}${b.key.slice(1)}Styles`;
      while (scope.has(imp) || new RegExp(`\\b${imp}\\b`).test(f.code)) imp += '_';
      b.importName = imp;
      const cssPath = path.join(dir, b.cssName);
      if (fs.existsSync(cssPath) && !opts.force && !fs.readFileSync(cssPath, 'utf8').startsWith(MARK)) {
        warnings.push(
          `${relFile}: ${b.cssName} уже существует и создан не tw2cssm — файл пропущен (используйте --force)`,
        );
        skip = true;
      }
      const css = fmtRoot(buildModuleCss(b.groups(), index, engine));
      if (/var\(--/.test(css)) needGlobals = true;
      cssFiles.push({ path: cssPath, text: `${MARK}\n\n${css}` });
    }
    if (skip) continue;

    const byId = new Map(used.map((b) => [b.id, b]));
    const fixed = edits.map((e) => ({
      ...e,
      text: e.text.replace(/@@S(\d+)@@/g, (_, i: string) => byId.get(+i)!.importName),
    }));
    const ip = A.insertPosition(f.ast, f.code);
    const lines = used.map((b) => `import ${b.importName} from ${ip.q}./${b.cssName}${ip.q}${ip.semi ? ';' : ''}`);
    const text = ip.prefix + lines.join('\n') + (ip.suffix || '');
    const out = A.applyEdits(f.code, fixed, { pos: ip.pos, text }).toString();
    writes.push({ path: f.file, text: out }, ...cssFiles);
    changedFiles++;
    modules += cssFiles.length;
    log(`  ✔ ${relFile} → ${cssFiles.map((c) => path.basename(c.path)).join(', ')}`);
  }

  // Глобальные стили (переменные темы, @property, @keyframes, preflight)
  if (needGlobals && changedFiles) {
    const gpath = path.resolve(
      cwd,
      opts.globals || path.join(fs.existsSync(path.join(cwd, 'src')) ? 'src' : '.', 'tailwind-globals.css'),
    );
    const parts: string[] = [];
    if (engine.preflight && engine.preflight.nodes.length) parts.push(fmtRoot(engine.preflight));
    if (engine.globals.nodes.length) parts.push(fmtRoot(engine.globals));
    writes.push({ path: gpath, text: `${MARK}\n\n${parts.join('\n')}` });
    log(`  ✔ ${rel(cwd, gpath)} (глобальные переменные Tailwind)`);
    const entry = opts.entry
      ? path.resolve(cwd, opts.entry)
      : fg.sync(['{src/,}{main,index}.{tsx,jsx,ts,js}', '{src/,}app/layout.{tsx,jsx,js}', '{src/,}pages/_app.{tsx,jsx,js}'], {
          cwd,
          absolute: true,
        })[0];
    let done = false;
    if (entry && fs.existsSync(entry)) {
      const code = fs.readFileSync(entry, 'utf8');
      const name = path.basename(gpath);
      if (code.includes(name)) done = true;
      else {
        const ast = A.parse(code, entry);
        const ip = A.insertPosition(ast, code);
        let r = path.relative(path.dirname(entry), gpath).replace(/\\/g, '/');
        if (!r.startsWith('.')) r = './' + r;
        const line = `import ${ip.q}${r}${ip.q}${ip.semi ? ';' : ''}`;
        const prev = writes.find((w) => w.path === entry);
        const src = prev ? prev.text : code;
        const at = prev ? 0 : ip.pos;
        const text = prev ? line + '\n' + src : src.slice(0, at) + ip.prefix + line + (ip.suffix || '') + src.slice(at);
        if (prev) prev.text = text;
        else writes.push({ path: entry, text });
        done = true;
        log(`  ✔ ${rel(cwd, entry)}: добавлен импорт ${r}`);
      }
    }
    if (!done) log(`  ! Подключите ${rel(cwd, gpath)} в точке входа приложения: import '${rel(cwd, gpath)}'`);
  }

  if (!opts.dryRun) {
    for (const w of writes) {
      fs.mkdirSync(path.dirname(w.path), { recursive: true });
      fs.writeFileSync(w.path, w.text);
    }
  }
  log(`\n${opts.dryRun ? '[dry-run] ' : ''}Файлов изменено: ${changedFiles}, CSS-модулей создано: ${modules}`);
  if (warnings.length) {
    log('\nПредупреждения:');
    [...new Set(warnings)].forEach((x) => log('  ⚠ ' + x));
  }
  log(`\nДальше:
  • Удалите @tailwind / @import "tailwindcss" из глобального CSS и tailwind из зависимостей, когда проверите результат.
  • Классы без правил Tailwind (свои, group/peer) оставлены строками как есть.
  • tailwind-merge (twMerge) после миграции не разрешает конфликты — замените его на clsx/classnames.`);
  if (opts.dryRun && opts.verbose) for (const w of writes) log(`\n----- ${rel(cwd, w.path)} -----\n${w.text}`);
}
