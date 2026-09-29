import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { run } from './run.js';

const HELP = `tw2cssm — замена Tailwind на CSS-модули в React-проекте (по модулю на компонент)

Использование:
  npx tw2cssm [пути...] [опции]

Пути — папки или файлы (по умолчанию ./src).

Опции:
  --dry-run          ничего не записывать; с --verbose печатает результат
  --config <файл>    tailwind.config.* (Tailwind v3)
  --css <файл>       главный CSS с @import "tailwindcss" и @theme (Tailwind v4)
  --globals <файл>   куда записать глобальные стили Tailwind (по умолчанию src/tailwind-globals.css)
  --entry <файл>     точка входа, куда добавить импорт глобальных стилей
  --preflight        сохранить Tailwind preflight (CSS-reset) в глобальных стилях
  --ignore <glob>    доп. исключения (можно несколько раз)
  --force            перезаписать существующие *.module.css
  --verbose          подробный вывод
  -h, --help         справка
  -v, --version      версия
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      config: { type: 'string' },
      css: { type: 'string' },
      globals: { type: 'string' },
      entry: { type: 'string' },
      preflight: { type: 'boolean' },
      ignore: { type: 'string', multiple: true },
      force: { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(version());
    return;
  }
  await run({
    cwd: process.cwd(),
    paths: positionals,
    dryRun: !!values['dry-run'],
    config: values.config,
    css: values.css,
    globals: values.globals,
    entry: values.entry,
    preflight: !!values.preflight,
    ignore: values.ignore || [],
    force: !!values.force,
    verbose: !!values.verbose,
  });
}
