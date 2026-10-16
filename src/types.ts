export interface RunOptions {
  /** рабочий каталог проекта */
  cwd: string;
  /** пути к папкам или файлам; пустой массив — корень проекта */
  paths: string[];
  /** ничего не записывать на диск */
  dryRun: boolean;
  /** путь к tailwind.config.* (Tailwind v3) */
  config?: string;
  /** путь к главному CSS с @import "tailwindcss" (Tailwind v4) */
  css?: string;
  /** путь к файлу preflight, если включён */
  globals?: string;
  /** точка входа, куда добавить импорт preflight */
  entry?: string;
  /** сохранить Tailwind preflight (reset) отдельным файлом */
  preflight: boolean;
  /** дополнительные glob-исключения */
  ignore: string[];
  /** перезаписывать существующие *.module.css */
  force: boolean;
  /** подробный вывод */
  verbose: boolean;
}
