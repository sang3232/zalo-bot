import crypto from 'crypto';
import { readJson, debouncedWriter } from './store.js';
import { bus } from './bus.js';

/** Lịch sử tin nhắn & cảnh báo gần đây cho giao diện (lưu ở data/history.json) */
const MAX_MESSAGES = 300;
const MAX_ALERTS = 200;

const loaded = readJson('history.json', {}) || {};
const state = {
    messages: Array.isArray(loaded.messages) ? loaded.messages : [],
    alerts: Array.isArray(loaded.alerts) ? loaded.alerts : []
};
const writer = debouncedWriter('history.json', () => state);

function push(list, item, max) {
    list.push(item);
    if (list.length > max) list.splice(0, list.length - max);
    writer.schedule();
}

export function addMessage(msg) {
    const item = {
        id: crypto.randomUUID(),
        at: Date.now(),
        sender: String(msg.sender ?? ''),
        content: String(msg.content ?? ''),
        isGroup: !!msg.isGroup,
        groupName: String(msg.groupName ?? ''),
        isTest: !!msg.isTest
    };
    push(state.messages, item, MAX_MESSAGES);
    bus.emit('chat', item);
    return item;
}

export function annotateMessage(id, decision) {
    const item = state.messages.find(m => m.id === id);
    if (!item) return;
    Object.assign(item, {
        urgent: !!decision.urgent,
        reason: decision.reason || '',
        source: decision.source || 'rule',
        alerted: !!decision.alerted
    });
    writer.schedule();
    bus.emit('chat-update', item);
}

export function addAlert(alert) {
    const item = {
        id: crypto.randomUUID(),
        at: Date.now(),
        sender: String(alert.sender ?? ''),
        content: String(alert.content ?? ''),
        reason: String(alert.reason ?? ''),
        source: alert.source || 'rule',
        isTest: !!alert.isTest
    };
    push(state.alerts, item, MAX_ALERTS);
    bus.emit('alert', item);
    return item;
}

export function getHistory() {
    return { messages: state.messages.slice(-150), alerts: state.alerts.slice(-100) };
}
