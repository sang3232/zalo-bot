import { exec } from 'child_process';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { addAlert } from './history.js';

/**
 * Báo động tại máy: ghi log, kêu còi trên máy tính, đẩy thông báo lên giao diện quản lý.
 * (Đã gỡ bỏ gọi điện Stringee / Twilio / CallMeBot và gửi Telegram.)
 */

function playLocalBeep() {
    try {
        exec('powershell -c "[console]::beep(1000,400); Start-Sleep -Milliseconds 100; [console]::beep(1200,400); Start-Sleep -Milliseconds 100; [console]::beep(1500,600)"');
    } catch (e) {}
}

export function raiseAlert({ sender, content, reason, source = 'rule', isTest = false }) {
    logger.alert({ sender, content, urgencyReason: reason, isTest });

    // Tin thử từ giao diện không kêu còi máy tính (giao diện tự phát âm thanh)
    if (!isTest && loadConfig().enableSoundAlert !== false) {
        playLocalBeep();
    }

    return addAlert({ sender, content, reason, source, isTest });
}
