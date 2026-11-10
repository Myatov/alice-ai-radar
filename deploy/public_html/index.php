<?php
// Радар ИИ-видимости — фронт-контроллер для хостинга без root-доступа.
//
// nginx на хостинге отдаёт public_html статикой, а всё, чего нет на диске,
// отправляет в index.php (try_files … /index.php). Свой proxy_pass без root
// не прописать, поэтому этот скрипт проксирует запрос в Node-приложение,
// которое слушает 127.0.0.1:ALICE_PORT (pm2, см. deploy/ecosystem.config.cjs).
//
// Ответ стримится по мере получения (SSE, выгрузка .docx), буфер nginx
// отключается заголовком X-Accel-Buffering. Для долгих запросов без
// промежуточного вывода (генерация выводов через OpenAI) прокси сам шлёт
// пробелы-keepalive, чтобы не упереться в fastcgi_read_timeout = 60 с.

declare(strict_types=1);

const UPSTREAM = 'http://127.0.0.1:18100';
const KEEPALIVE_AFTER = 20; // с без ответа апстрима до первого пробела
const KEEPALIVE_EVERY = 15; // с между пробелами

set_time_limit(0);
while (ob_get_level() > 0) {
    ob_end_flush();
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$uri = $_SERVER['REQUEST_URI'] ?? '/';
$path = (string) parse_url($uri, PHP_URL_PATH);

// В nginx `index index.php index.html` — корень сайта попадает сюда, а не в
// index.html. Отдаём SPA сами, Node для этого не нужен.
if ($path === '/' && ($method === 'GET' || $method === 'HEAD')) {
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    if ($method === 'GET') {
        readfile(__DIR__ . '/index.html');
    }
    exit;
}

// Пустые пробелы перед JSON — валидный JSON, поэтому keepalive безопасен
// только для JSON-ответов, где фронт и так читает res.json().
$keepaliveAllowed = $method === 'POST' && preg_match('#^/api/project/\d+/insights$#', $path) === 1;

$skip = ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'expect', 'keep-alive'];
$reqHeaders = [];
foreach (getallheaders() as $name => $value) {
    if (!in_array(strtolower($name), $skip, true)) {
        $reqHeaders[] = $name . ': ' . $value;
    }
}
$reqHeaders[] = 'Host: ' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
$reqHeaders[] = 'X-Forwarded-For: ' . ($_SERVER['REMOTE_ADDR'] ?? '');
$reqHeaders[] = 'X-Forwarded-Proto: https';
$reqHeaders[] = 'Expect:';

$state = [
    'status' => 0,
    'headers' => [],
    'committed' => false, // заголовки клиенту уже отправлены
    'started' => time(),
    'lastKeepalive' => 0,
];

$commit = static function () use (&$state): void {
    if ($state['committed']) {
        return;
    }
    $state['committed'] = true;
    http_response_code($state['status'] ?: 502);
    $hop = ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'x-accel-buffering'];
    foreach ($state['headers'] as [$name, $value]) {
        if (!in_array(strtolower($name), $hop, true)) {
            header($name . ': ' . $value, false);
        }
    }
    header('X-Accel-Buffering: no');
};

$ch = curl_init(UPSTREAM . $uri);
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_HTTPHEADER => $reqHeaders,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 0,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
    CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$state, $commit): int {
        $trimmed = rtrim($line, "\r\n");
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $trimmed, $m)) {
            $state['status'] = (int) $m[1];
            $state['headers'] = [];
        } elseif ($trimmed === '') {
            if ($state['status'] >= 200) {
                $commit();
            }
        } elseif (strpos($trimmed, ':') !== false) {
            [$name, $value] = explode(':', $trimmed, 2);
            $state['headers'][] = [trim($name), trim($value)];
        }
        return strlen($line);
    },
    CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use ($commit): int {
        $commit();
        echo $chunk;
        flush();
        return connection_aborted() ? 0 : strlen($chunk);
    },
    CURLOPT_NOPROGRESS => false,
    CURLOPT_XFERINFOFUNCTION => static function () use (&$state, $keepaliveAllowed): int {
        // Как только апстрим начал отвечать, keepalive больше не нужен.
        if (!$keepaliveAllowed || $state['status'] !== 0) {
            return 0;
        }
        $now = time();
        if ($now - $state['started'] < KEEPALIVE_AFTER || $now - $state['lastKeepalive'] < KEEPALIVE_EVERY) {
            return 0;
        }
        if (!$state['committed']) {
            $state['committed'] = true;
            http_response_code(200);
            header('Content-Type: application/json; charset=utf-8');
            header('Cache-Control: no-store');
            header('X-Accel-Buffering: no');
        }
        $state['lastKeepalive'] = $now;
        echo ' ';
        flush();
        return connection_aborted() ? 1 : 0;
    },
]);

if ($method !== 'GET' && $method !== 'HEAD') {
    curl_setopt($ch, CURLOPT_POSTFIELDS, (string) file_get_contents('php://input'));
}
if ($method === 'HEAD') {
    curl_setopt($ch, CURLOPT_NOBODY, true);
}

$ok = curl_exec($ch);
$error = curl_error($ch);
curl_close($ch);

if ($ok === false && !$state['committed'] && !connection_aborted()) {
    http_response_code(502);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(
        ['error' => 'Сервис временно недоступен, попробуйте через минуту', 'detail' => $error],
        JSON_UNESCAPED_UNICODE
    );
}
