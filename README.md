# tw2cssm

CLI, который заменяет Tailwind-классы в React-проекте на **CSS-модули** — по одному модулю на файл с компонентами.

Используется настоящий движок Tailwind из вашего проекта (v3 и v4), поэтому конфиг, тема, плагины,
произвольные значения (`w-[calc(100%-2rem)]`) и варианты (`hover:`, `md:`, `dark:`, `group-hover:`) работают как раньше.

## Требования

- Node.js >= 18.3
- `tailwindcss` >= 3.3 в проекте (используется движок проекта)

Пакет написан на TypeScript 7 (native compiler), собирается в ESM и публикуется с декларациями типов.

## Установка

```bash
npx tw2cssm --dry-run --verbose   # посмотреть результат

npm i -D tw2cssm                  # в проект
npx tw2cssm                       # применить (по умолчанию ./src)
```

Перед запуском сделайте коммит — файлы переписываются на месте.

## Что происходит

```tsx
// было
<button className={clsx('px-4 py-2 hover:bg-blue-600', active && 'ring-2')}>

// стало
import styles from './Button.module.css';
<button className={clsx(styles.button, active && styles.buttonActive)}>
```

- Поддерживаются `className="…"`, `{'…'}`, шаблонные строки, тернарники, `&&`, массивы, объекты,
  `clsx / cn / cx / classnames / twMerge / twJoin` и `cva` (база, `variants`, `compoundVariants`).
- Один CSS-модуль на файл: `Button.tsx` → `Button.module.css`, даже если в файле несколько компонентов.
  Корневой класс первого компонента называется `root`, следующих — `имяКомпонентаRoot`.
- Классы, у которых нет правил в Tailwind (свои, `group`, `peer`), остаются строками.
- Порядок каскада Tailwind сохраняется; одинаковые наборы классов переиспользуют один класс модуля.
- Переменные темы, `@property`, `@keyframes` (v4) и `--tw-*` (v3) выносятся в `tailwind-globals.css`,
  который автоматически импортируется в точку входа (`--entry`, если не нашлась).

## Опции

| Опция | Описание |
|---|---|
| `--dry-run` | ничего не записывать (`--verbose` печатает файлы) |
| `--config <файл>` | `tailwind.config.*` (v3) |
| `--css <файл>` | главный CSS с `@import "tailwindcss"` и `@theme` (v4), по умолчанию ищется сам |
| `--globals <файл>` | путь к файлу глобальных стилей |
| `--entry <файл>` | точка входа для импорта глобальных стилей |
| `--preflight` | сохранить Tailwind preflight (reset) в глобальных стилях |
| `--ignore <glob>` | дополнительные исключения |
| `--force` | перезаписать существующие `*.module.css` |

## API

Пакет экспортирует ту же логику, что и CLI, — можно вызывать из скриптов:

```ts
import { run } from 'tw2cssm';

await run({
  cwd: process.cwd(),
  paths: ['src'],
  dryRun: true,
  preflight: false,
  ignore: ['**/*.stories.tsx'],
  force: false,
  verbose: true,
});
```

## Разработка

```bash
npm install
npm run build       # tsc -> dist/ (JS + .d.ts + source maps)
npm run typecheck   # проверка типов без записи
npm run verify      # typecheck + чистая сборка (запускается в prepublishOnly)
node bin/tw2cssm.js examples --dry-run --verbose
```

Исходники — `src/*.ts`, сборка — `dist/*.js` (ESM, `"type": "module"`).
Перед публикацией: `npm pack --dry-run` и `npm publish` (версия и `license` — в `package.json`).

## Ограничения

- Динамические классы (`` `p-${n}` ``, классы из переменных/функций) не преобразуются — выводится предупреждение.
- `group`/`peer` остаются глобальными классами (как в Tailwind), поэтому работают и между компонентами.
- `tailwind-merge` больше не разрешает конфликты классов — замените на `clsx`.
- Стили, заданные вне `className` (например, в `.css`, `@apply`), не затрагиваются.
- Для TypeScript нужны декларации `*.module.css` (есть в Vite, Next.js и CRA).
- После проверки удалите `@tailwind`/`@import "tailwindcss"` и сам tailwind из зависимостей.

## Лицензия

MIT
