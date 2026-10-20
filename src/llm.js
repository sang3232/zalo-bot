import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { getApiKey } from './ai.js';
import { loadConfig } from './config.js';

/**
 * Gọi model lên lịch qua OpenRouter (mặc định z-ai/glm-5.3-flash), bắt trả JSON đúng khuôn.
 * Khác ai.js (phân tích khẩn cấp từng tin, model chọn trong giao diện): đây là việc đọc file / gom
 * ngữ cảnh dài, cần JSON theo khuôn chặt và rẻ → model riêng (autoSchedule.model trong config, hoặc GLM_MODEL).
 * Khoá: dùng chung khoá của bot (giao diện → Cài đặt, hoặc OPENROUTER_API_KEY); chưa có thì dùng
 * khoá OpenRouter của Yuyuko (YUYUKO_DIR\config.json → openrouter_key).
 */

const BASE_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
export const DEFAULT_SCHEDULE_MODEL = 'z-ai/glm-5.3-flash';
const TIMEOUT_MS = 120000;
const RETRY_DELAYS_MS = [3000, 10000];

let yuyukoKey = null;

function khoaYuyuko() {
    if (yuyukoKey !== null) return yuyukoKey;
    yuyukoKey = '';
    const dir = process.env.YUYUKO_DIR;
    if (!dir) return yuyukoKey;
    for (const [file, field] of [['config.json', 'openrouter_key'], ['story_config_cloud.json', 'openrouter_api_key']]) {
        try {
            const cfg = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
            const k = String(cfg[field] || '').trim();
            if (k) return (yuyukoKey = k);
        } catch (e) {
            if (e.code !== 'ENOENT') logger.warn(`[GLM] Không đọc được khoá OpenRouter trong ${file} của Yuyuko: ${e.message}`);
        }
    }
    return yuyukoKey;
}

export function getScheduleKey() {
    return getApiKey() || khoaYuyuko() || null;
}

function parseJsonReply(text) {
    const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(s);
}

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/**
 * @param {{ system: string, user: string, schemaName: string, schema: object, maxTokens?: number, tag?: string, model?: string,
 *           images?: { b64: string, mime: string }[] }} opts  images: ảnh gửi kèm (model phải đọc được ảnh)
 * @returns {Promise<{ data: any, usage: object }>}
 */
export async function askJson({ system, user, schemaName, schema, maxTokens = 8000, tag = 'GLM', model, images = [] }) {
    const key = getScheduleKey();
    if (!key) throw new Error('Chưa có khoá OpenRouter (giao diện → Cài đặt, hoặc OPENROUTER_API_KEY / YUYUKO_DIR trong .env)');

    const body = {
        model: model || loadConfig().autoSchedule?.model || process.env.GLM_MODEL || DEFAULT_SCHEDULE_MODEL,
        messages: [
            { role: 'system', content: system },
            {
                role: 'user',
                content: images.length
                    ? [{ type: 'text', text: user }, ...images.map(a => ({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.b64}` } }))]
                    : user
            }
        ],
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
        // GLM để mặc định thì nghĩ rất nhiều và tiền nằm ở token nghĩ — việc này chỉ cần nghĩ ít
        reasoning: { effort: 'low', exclude: true },
        // Chỉ đi qua nhà cung cấp hỗ trợ JSON theo khuôn và không giữ dữ liệu để huấn luyện
        // autoSchedule.provider: thêm tuỳ chọn định tuyến của OpenRouter, VD { "ignore": ["OpenInference"] }
        provider: { require_parameters: true, data_collection: 'deny', ...(loadConfig().autoSchedule?.provider || {}) },
        usage: { include: true },
        max_tokens: maxTokens,
        temperature: 0.1
    };

    for (let attempt = 0; ; attempt++) {
        const t0 = Date.now();
        try {
            let res;
            try {
                res = await fetch(`${BASE_URL}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${key}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'http://127.0.0.1',
                        'X-Title': 'Zalo Emergency Monitor'
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(TIMEOUT_MS)
                });
            } catch (e) {
                throw new Error(e.name === 'TimeoutError' ? `không phản hồi sau ${TIMEOUT_MS / 1000} giây` : `không kết nối được: ${e.message}`);
            }
            const data = await res.json().catch(() => null);
            if (!res.ok || data?.error) throw new HttpError(res.status, data?.error?.message || `HTTP ${res.status}`);

            const choice = data?.choices?.[0];
            const usage = data?.usage || {};
            logger.info(`[${tag}] ${data?.model || body.model} @${data?.provider || '?'} — ${usage.prompt_tokens ?? '?'}→${usage.completion_tokens ?? '?'} token, $${Number(usage.cost || 0).toFixed(5)}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            if (!choice?.message?.content) throw new Error(`Model trả rỗng (finish_reason=${choice?.finish_reason})`);
            return { data: parseJsonReply(choice.message.content), usage };
        } catch (err) {
            const status = err.status;
            const retryable = status === undefined || status === 429 || status >= 500;
            if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
                throw new Error(`[${tag}] Gọi model thất bại${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
            }
            logger.warn(`[${tag}] Lỗi ${status || err.message} — thử lại sau ${RETRY_DELAYS_MS[attempt] / 1000}s`);
            await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        }
    }
}
