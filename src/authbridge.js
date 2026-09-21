'use strict';

/**
 * DSH 认证桥（桌面端内置）
 *
 * 作用：让「重启后不需要 key」对任何设备成立。
 * 做法：本模块在 Electron 主进程里起一个**只监听回环**的反向代理
 *       127.0.0.1:<port> → 127.0.0.1:<targetPort>（默认 3090 → 3080）。
 *       请求若「没有该域名的有效 dsh-auth cookie」，就用 DSH 的持久签名密钥
 *       （$DSH_HOME/.credentials.yaml 的 client-connection/browser-session secret）
 *       当场铸一枚 cookie 注入后再转发；已有有效 cookie 的原样透传。
 *
 * 为什么：dsh 的访问 token 每次进程启动随机、只存内存（重启即作废），
 *       而 cookie 用持久密钥签名、可跨重启存活。桥把「取凭据」这一步自动化，
 *       于是外部（tailscale serve）只需指向桥端口，客户端打开干净地址即可。
 *
 * 安全：只监听 127.0.0.1；对外暴露仍由 tailnet-only 的 tailscale serve 决定。
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, createHmac, timingSafeEqual } = require('crypto');

const DEFAULT_PORT = 3090;
const DEFAULT_TARGET_PORT = 3080;
// dsh 服务端 client-connection 默认 cookieMaxAgeDays=30，且要求
// (expiresAt - issuedAt) <= 上限 → 这里留 60s 余量，避免边界被拒。
const COOKIE_TTL_MS = 30 * 86400 * 1000 - 60000;

let server = null;
let config = {
  port: DEFAULT_PORT,
  targetPort: DEFAULT_TARGET_PORT,
  credentialsPath: '',
  log: () => {},
};
let secretCache = { mtimeMs: 0, bytes: null };

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
const b64uDecode = (str) =>
  Buffer.from(
    String(str).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(str).length % 4)) % 4),
    'base64'
  );

function resolveCredentialsPath() {
  if (config.credentialsPath) return config.credentialsPath;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, '.credentials.yaml');
}

/** 读取持久签名密钥（按 mtime 缓存，文件更新自动重读） */
function loadSecret() {
  try {
    const file = resolveCredentialsPath();
    const st = fs.statSync(file);
    if (secretCache.bytes && secretCache.mtimeMs === st.mtimeMs) return secretCache.bytes;
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{40,})/);
    if (!m) return null;
    const bytes = b64uDecode(m[1]);
    if (bytes.length !== 32) return null;
    secretCache = { mtimeMs: st.mtimeMs, bytes };
    return bytes;
  } catch {
    return null;
  }
}

const cookieName = (authority) => 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest());

function mintCookie(authority) {
  const secret = loadSecret();
  if (!secret) return null;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + COOKIE_TTL_MS;
  const payload = { version: 1, authority, issuedAt, expiresAt };
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64u(createHmac('sha256', secret).update(body).digest());
  return cookieName(authority) + '=v1.' + body + '.' + sig;
}

/** 客户端自带的 cookie 是否「本域名 + 本密钥 + 未过期」 */
function cookieStillValid(rawCookie, authority) {
  if (!rawCookie) return false;
  const name = cookieName(authority);
  let value = '';
  for (const seg of String(rawCookie).split(';')) {
    const at = seg.indexOf('=');
    if (at === -1) continue;
    if (seg.slice(0, at).trim() === name) {
      value = seg.slice(at + 1).trim();
      break;
    }
  }
  if (!value) return false;
  const parts = String(value).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const secret = loadSecret();
  if (!secret) return false;
  const expect = createHmac('sha256', secret).update(parts[1]).digest();
  let actual;
  try {
    actual = b64uDecode(parts[2]);
  } catch {
    return false;
  }
  if (!actual || actual.length !== expect.length || !timingSafeEqual(actual, expect)) return false;
  try {
    const payload = JSON.parse(b64uDecode(parts[1]).toString('utf8'));
    return (
      payload.authority === authority && payload.issuedAt <= Date.now() && payload.expiresAt > Date.now()
    );
  } catch {
    return false;
  }
}

/** 组装转发头：cookie 缺失或失效时替换为现铸的一枚 */
function buildForwardHeaders(req, authority) {
  const headers = Object.assign({}, req.headers);
  const raw = req.headers.cookie;
  if (cookieStillValid(raw, authority)) return { headers, injected: false };
  const fresh = mintCookie(authority);
  if (!fresh) return { headers, injected: false };
  const name = cookieName(authority) + '=';
  const others = raw
    ? String(raw)
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && s.indexOf(name) !== 0)
    : [];
  headers.cookie = others.concat([fresh]).join('; ');
  return { headers, injected: true };
}

function handleRequest(req, res) {
  const authority = req.headers.host || `127.0.0.1:${config.targetPort}`;
  const built = buildForwardHeaders(req, authority);
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: config.targetPort,
      method: req.method,
      path: req.url,
      headers: built.headers,
    },
    (up) => {
      if (built.injected) config.log(`[inject] ${req.method} ${req.url} host=${authority}`);
      if (up.statusCode === 401) config.log(`[warn] 上游 401（密钥来源可能已变）host=${authority} ${req.url}`);
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    config.log(`[error] 转发失败：${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('authbridge: upstream unreachable\n');
  });
  req.pipe(upstream);
}

/** WebSocket / Upgrade：原样透传（含注入后的头） */
function handleUpgrade(req, socket, head) {
  const authority = req.headers.host || `127.0.0.1:${config.targetPort}`;
  const built = buildForwardHeaders(req, authority);
  if (built.injected) config.log(`[inject:ws] ${req.url} host=${authority}`);
  const upstream = net.connect(config.targetPort, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const key of Object.keys(built.headers)) {
      const value = built.headers[key];
      if (Array.isArray(value)) value.forEach((v) => lines.push(`${key}: ${v}`));
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

/**
 * 启动认证桥（幂等：已在运行直接返回当前状态）
 *
 * ⚠️ 必须等 listen 的真实结果再返回。
 * 之前这里 `server.listen(...)` 之后立刻 `return { ok: true }` —— 但 listen 是
 * **异步**的：端口被占时错误在 'error' 事件里异步抛出，而函数早已返回 ok:true。
 * 后果：remote-expose 拿到 br.ok===true 就把 tailscale serve 指向 3090，
 * 而 3090 上实际是别的进程（或空）→ 远端指向错的东西。
 *
 * 现在返回 Promise，resolve 时 ok 一定反映真实绑定结果。
 * @param {{port?: number, targetPort?: number, credentialsPath?: string, log?: Function}} options
 * @returns {Promise<{ok: boolean, port: number, running: boolean, reason?: string}>}
 */
function start(options) {
  const opts = options || {};
  config = {
    port: Number(opts.port) || DEFAULT_PORT,
    targetPort: Number(opts.targetPort) || DEFAULT_TARGET_PORT,
    credentialsPath: opts.credentialsPath || '',
    log: typeof opts.log === 'function' ? opts.log : () => {},
  };
  // 幂等：已在监听直接返回
  if (server && server.listening) {
    return Promise.resolve({ ok: true, port: config.port, running: true });
  }

  const srv = http.createServer(handleRequest);
  srv.on('upgrade', handleUpgrade);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    srv.on('error', (err) => {
      config.log(`[error] 认证桥启动失败：${err.message}`);
      if (server === srv) server = null;
      try {
        srv.close();
      } catch {
        /* ignore */
      }
      settle({ ok: false, port: config.port, running: false, reason: err.message });
    });

    try {
      srv.listen(config.port, '127.0.0.1', () => {
        server = srv;
        config.log(`[start] 认证桥就绪 http://127.0.0.1:${config.port} → 127.0.0.1:${config.targetPort}`);
        settle({ ok: true, port: config.port, running: true });
      });
    } catch (err) {
      // listen 同步抛（参数非法等）
      if (server === srv) server = null;
      settle({ ok: false, port: config.port, running: false, reason: err.message });
    }
  });
}

function stop() {
  if (!server) return;
  try {
    server.close();
  } catch {
    /* ignore */
  }
  server = null;
}

function status() {
  return {
    running: Boolean(server && server.listening),
    port: config.port,
    targetPort: config.targetPort,
  };
}

module.exports = { start, stop, status, DEFAULT_PORT, COOKIE_TTL_MS };
