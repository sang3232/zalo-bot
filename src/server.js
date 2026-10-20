import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { bus } from './bus.js';
import { logger } from './logger.js';
import { loadConfig, saveConfig, ConfigError } from './config.js';
import { listTasks, createTask, updateTask, deleteTask } from './tasks.js';
import { getHistory } from './history.js';
import { getSecret, setSecret } from './store.js';
import { getAiStatus, testConnection } from './ai.js';

/**
 * Máy chủ giao diện quản lý.
 * Bảo mật:
 *  - Chỉ nghe trên 127.0.0.1 (máy khác trong mạng LAN không truy cập được)
 *  - Kiểm tra Host → chống DNS rebinding (trang web lạ trỏ tên miền về 127.0.0.1 để đọc dữ liệu)
 *  - Cookie phiên HttpOnly + SameSite=Strict, kiểm tra Origin / Sec-Fetch-Site, chỉ nhận JSON → chống CSRF
 *  - CSP chỉ cho chạy script của chính trang; giới hạn kích thước body
 *  - API key OpenRouter không bao giờ được gửi về trình duyệt (chỉ bản che)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const STATIC_FILES = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
const SESSION_COOKIE = 'zb_session';
const MAX_BODY_BYTES = 64 * 1024;
const MODEL_ID = /^[A-Za-z0-9._\-:/~]{1,120}$/;
const API_KEY_FORMAT = /^[\x21-\x7e]{20,300}$/;
const TASK_PATH = /^\/api\/tasks\/([0-9a-f-]{36})$/;
const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
};

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function getUiToken() {
    let token = getSecret('uiToken');
    if (!token) {
        token = crypto.randomBytes(32).toString('hex');
        setSecret('uiToken', token);
    }
    return token;
}

function readCookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const index = part.indexOf('=');
        if (index > -1 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
    }
    return null;
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES * 16) return req.destroy();
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (tooLarge) return reject(new HttpError(413, 'Dữ liệu gửi lên quá lớn'));
            if (!size) return resolve({});
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
                resolve(body);
            } catch {
                reject(new HttpError(400, 'JSON không hợp lệ'));
            }
        });
        req.on('error', reject);
    });
}

function serveStatic(res, [file, type], token) {
    fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
        if (err) return sendJson(res, 404, { error: 'Không tìm thấy' });
        res.setHeader('Content-Type', type);
        if (file === 'index.html') {
            res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        }
        res.writeHead(200);
        res.end(data);
    });
}

/**
 * @param {{ port: number, getBotStatus: () => object, onTestMessage: (msg: object) => Promise<object> }} options
 * @returns {Promise<{ server: http.Server, port: number }>}
 */
export function startServer({ port, getBotStatus, onTestMessage }) {
    const token = getUiToken();
    const clients = new Set();
    let allowedHosts = new Set();
    let allowedOrigins = new Set();

    // Đẩy sự kiện thời gian thực lên giao diện (Server-Sent Events)
    const broadcast = (event, data) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of clients) res.write(payload);
    };
    bus.on('chat', m => broadcast('chat', m));
    bus.on('chat-update', m => broadcast('chat-update', m));
    bus.on('alert', a => broadcast('alert', a));
    bus.on('notice', n => broadcast('notice', n));   // nhắc lịch, đã lên lịch từ file/ảnh, cần tải file
    bus.on('tasks', t => broadcast('tasks', t));
    bus.on('status', s => broadcast('status', s));
    bus.on('config', c => broadcast('config', c));
    bus.on('ai', () => broadcast('ai', getAiStatus(loadConfig())));
    setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

    async function handleApi(req, res, url) {
        const { method } = req;
        const route = url.pathname;

        if (method === 'GET' && route === '/api/state') {
            const config = loadConfig();
            return sendJson(res, 200, { bot: getBotStatus(), ai: getAiStatus(config), config, tasks: listTasks(), ...getHistory() });
        }

        if (method === 'GET' && route === '/api/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
            res.write('retry: 3000\n\n');
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
        }

        if (method === 'PUT' && route === '/api/config') {
            const config = saveConfig(await readBody(req));
            bus.emit('config', config);
            bus.emit('ai');
            return sendJson(res, 200, { config });
        }

        if (method === 'PUT' && route === '/api/openrouter/key') {
            const { key } = await readBody(req);
            const value = typeof key === 'string' ? key.trim() : '';
            if (!API_KEY_FORMAT.test(value)) throw new HttpError(400, 'API key không hợp lệ (không được chứa khoảng trắng)');
            setSecret('openrouterApiKey', value);
            bus.emit('ai');
            return sendJson(res, 200, { ai: getAiStatus(loadConfig()) });
        }

        if (method === 'DELETE' && route === '/api/openrouter/key') {
            setSecret('openrouterApiKey', null);
            bus.emit('ai');
            return sendJson(res, 200, { ai: getAiStatus(loadConfig()) });
        }

        if (method === 'POST' && route === '/api/openrouter/test') {
            const { model } = await readBody(req);
            const useModel = typeof model === 'string' && MODEL_ID.test(model.trim()) ? model.trim() : loadConfig().ai.model;
            return sendJson(res, 200, await testConnection(useModel));
        }

        if (method === 'POST' && route === '/api/tasks') {
            return sendJson(res, 201, { task: createTask(await readBody(req), { type: 'manual' }) });
        }

        const taskMatch = route.match(TASK_PATH);
        if (taskMatch && method === 'PATCH') {
            return sendJson(res, 200, { task: updateTask(taskMatch[1], await readBody(req)) });
        }
        if (taskMatch && method === 'DELETE') {
            deleteTask(taskMatch[1]);
            return sendJson(res, 200, { ok: true });
        }

        if (method === 'POST' && route === '/api/test-message') {
            const body = await readBody(req);
            const sender = typeof body.sender === 'string' ? body.sender.trim().slice(0, 100) : '';
            const content = typeof body.content === 'string' ? body.content.trim().slice(0, 2000) : '';
            if (!content) throw new HttpError(400, 'Hãy nhập nội dung tin nhắn thử');
            const isGroup = body.isGroup === true;
            const decision = await onTestMessage({
                sender: sender || 'Tin thử',
                content,
                isGroup,
                groupName: isGroup ? (sender || 'Nhóm thử') : ''
            });
            return sendJson(res, 200, { decision });
        }

        throw new HttpError(404, 'Không tìm thấy');
    }

    const server = http.createServer(async (req, res) => {
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
        try {
            if (!allowedHosts.has(req.headers.host)) throw new HttpError(403, 'Host không hợp lệ');
            const url = new URL(req.url, `http://${req.headers.host}`);

            const staticFile = STATIC_FILES.get(url.pathname);
            if (staticFile && req.method === 'GET') return serveStatic(res, staticFile, token);
            if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Không tìm thấy');

            const fetchSite = req.headers['sec-fetch-site'];
            if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw new HttpError(403, 'Yêu cầu từ trang web khác bị chặn');
            if (!safeEqual(readCookie(req, SESSION_COOKIE), token)) throw new HttpError(401, 'Phiên không hợp lệ, hãy tải lại trang');
            if (req.method !== 'GET') {
                const origin = req.headers.origin;
                if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, 'Origin không hợp lệ');
                if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Chỉ nhận dữ liệu JSON');
            }

            await handleApi(req, res, url);
        } catch (e) {
            const status = e.status || (e instanceof ConfigError ? 400 : 500);
            if (status >= 500) logger.error('[Giao diện] Lỗi máy chủ', e.message);
            if (res.headersSent) return res.end();
            sendJson(res, status, { error: status >= 500 ? 'Lỗi máy chủ, xem logs/app.log' : e.message });
        }
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            const actualPort = server.address().port;
            allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
            allowedOrigins = new Set([...allowedHosts].map(host => `http://${host}`));
            resolve({ server, port: actualPort });
        });
    });
}
