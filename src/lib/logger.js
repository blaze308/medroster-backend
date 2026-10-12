import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const AUDIT_LOG = path.join(LOG_DIR, 'audit.log');

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function write(level, category, message, meta = {}) {
    const ts = new Date().toISOString();
    const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
    const line = `[${ts}] [${level.toUpperCase()}] [${category}] ${message}${metaStr}\n`;
    try {
        ensureLogDir();
        fs.appendFileSync(AUDIT_LOG, line);
    } catch {
        console.error('Log write failed:', line);
    }
}

export const logDataModification = (action, entity, id, details = {}) =>
    write('info', 'DATA_MODIFICATION', `${action} ${entity} (ID: ${id})`, details);

export const logValidationFailure = (schedId, errors) =>
    write('warn', 'VALIDATION', `Validation failed for schedule ${schedId}`, { errorCount: errors.length, errors });

export const logAutoGeneration = (schedId, staffCount, assignmentCount, durationMs) =>
    write('info', 'AUTO_GENERATION', `Auto-generated schedule ${schedId}`, { staffCount, assignmentCount, durationMs });

export const logError = (category, message, err) => {
    console.error(`[${category}] ${message}`, err?.code || '', err?.message || err);
    if (err instanceof Error || err?.stack) {
        write('error', category, message, { error: err?.message, code: err?.code, stack: err?.stack, status: err?.status });
        return;
    }
    if (err && typeof err === 'object') {
        write('error', category, message, err);
        return;
    }
    write('error', category, message, { error: String(err ?? '') });
};

export const logInfo = (category, message, meta = {}) =>
    write('info', category, message, meta);
