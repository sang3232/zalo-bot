import crypto from 'crypto';
import { readJson, writeJson } from './store.js';
import { bus } from './bus.js';

/** Hệ thống công việc: tạo tay trên giao diện, tự tạo từ cảnh báo, hoặc AI trích từ tin nhắn Zalo */

export class TaskError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export const PRIORITIES = ['high', 'medium', 'low'];
export const STATUSES = ['todo', 'doing', 'done'];
const MAX_TASKS = 2000;

let tasks = readJson('tasks.json', []);
if (!Array.isArray(tasks)) tasks = [];

function persist() {
    writeJson('tasks.json', tasks);
    bus.emit('tasks', tasks);
}

/**
 * Chuẩn hóa hạn chót về 'YYYY-MM-DD' hoặc 'YYYY-MM-DDTHH:mm' (giờ máy). Sai định dạng / ngày không tồn tại → null
 */
export function normalizeDue(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?/);
    if (!m) return null;
    const [, y, mo, d, hh, mm] = m;
    if (hh !== undefined && (Number(hh) > 23 || Number(mm) > 59)) return null;
    const date = new Date(Number(y), Number(mo) - 1, Number(d));
    if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null;
    const thisYear = new Date().getFullYear();
    if (Number(y) < thisYear - 1 || Number(y) > thisYear + 5) return null;
    return hh !== undefined ? `${y}-${mo}-${d}T${hh}:${mm}` : `${y}-${mo}-${d}`;
}

function text(value, max, label, required = false) {
    if (value === undefined || value === null) {
        if (required) throw new TaskError(`Thiếu ${label}`);
        return '';
    }
    if (typeof value !== 'string') throw new TaskError(`${label} không hợp lệ`);
    const s = value.trim();
    if (required && !s) throw new TaskError(`Thiếu ${label}`);
    if (s.length > max) throw new TaskError(`${label} quá dài (tối đa ${max} ký tự)`);
    return s;
}

// Chỉ các trường này được sửa từ bên ngoài (id, source, ngày tạo... do máy chủ quản lý)
function applyFields(task, input, isCreate) {
    if (isCreate || 'title' in input) task.title = text(input.title, 200, 'tiêu đề', true);
    if ('note' in input) task.note = text(input.note, 2000, 'ghi chú');
    if ('due' in input) {
        const due = normalizeDue(input.due);
        if (input.due && !due) throw new TaskError('Hạn chót không hợp lệ');
        task.due = due;
    }
    if ('priority' in input) {
        if (!PRIORITIES.includes(input.priority)) throw new TaskError('Mức ưu tiên không hợp lệ');
        task.priority = input.priority;
    }
    if ('status' in input) {
        if (!STATUSES.includes(input.status)) throw new TaskError('Trạng thái không hợp lệ');
        task.status = input.status;
    }
}

export function listTasks() {
    return tasks;
}

/**
 * @param {object} input - { title, note?, due?, priority?, status? }
 * @param {object} source - do máy chủ tạo: { type: 'manual'|'zalo'|'alert', sender?, content?, dedupeKey?, isTest? }
 * @returns {object|null} null nếu đã có việc cùng dedupeKey
 */
export function createTask(input, source = { type: 'manual' }) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskError('Dữ liệu công việc không hợp lệ');
    if (source.dedupeKey && tasks.some(t => t.source?.dedupeKey === source.dedupeKey)) return null;
    if (tasks.length >= MAX_TASKS) throw new TaskError('Đã có quá nhiều công việc, hãy xoá bớt việc đã xong');

    const now = new Date().toISOString();
    const task = {
        id: crypto.randomUUID(),
        title: '',
        note: '',
        due: null,
        priority: 'medium',
        status: 'todo',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        source
    };
    applyFields(task, input, true);
    if (task.status === 'done') task.completedAt = now;
    tasks.push(task);
    persist();
    return task;
}

export function updateTask(id, patch) {
    const task = tasks.find(t => t.id === id);
    if (!task) throw new TaskError('Không tìm thấy công việc', 404);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TaskError('Dữ liệu công việc không hợp lệ');

    const draft = { ...task };
    applyFields(draft, patch, false);
    if (draft.status !== task.status) draft.completedAt = draft.status === 'done' ? new Date().toISOString() : null;
    draft.updatedAt = new Date().toISOString();
    Object.assign(task, draft);
    persist();
    return task;
}

export function deleteTask(id) {
    const index = tasks.findIndex(t => t.id === id);
    if (index === -1) throw new TaskError('Không tìm thấy công việc', 404);
    tasks.splice(index, 1);
    persist();
}
