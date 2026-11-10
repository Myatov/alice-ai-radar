// pm2-конфиг для хостинга alice.seo-performance.ru (пользователь aliceseo, без root).
// Системный Node на сервере — v20, а приложению нужен node:sqlite (Node ≥ 22.5),
// поэтому запускаем собственный Node 24 из домашнего каталога напрямую,
// без обёртки pm2 (interpreter: 'none').
const HOME = '/var/www/alice.seo-performance.ru';

module.exports = {
  apps: [
    {
      name: 'alice-radar',
      cwd: `${HOME}/app`,
      script: `${HOME}/node24/bin/node`,
      args: '--env-file=.env src/server.mjs',
      interpreter: 'none',
      env: {
        PORT: '18100',
        HOST: '127.0.0.1',
        // OpenAI блокирует российские IP (403 unsupported_country_region_territory).
        // На сервере есть HTTP-прокси 127.0.0.1:3128 с выходом в NL — пускаем
        // через него внешние запросы, кроме Keys.so (российский API, ходим напрямую).
        NODE_USE_ENV_PROXY: '1',
        HTTPS_PROXY: 'http://127.0.0.1:3128',
        NO_PROXY: 'localhost,127.0.0.1,keys.so,.keys.so',
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      out_file: `${HOME}/app/logs/out.log`,
      error_file: `${HOME}/app/logs/err.log`,
      merge_logs: true,
      time: true,
    },
  ],
};
