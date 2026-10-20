import { EventEmitter } from 'events';

// Kênh sự kiện nội bộ: bot → giao diện (tin nhắn, cảnh báo, công việc, trạng thái)
export const bus = new EventEmitter();
bus.setMaxListeners(100);
