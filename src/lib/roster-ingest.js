import JSZip from 'jszip';
import { parseDocxRoster } from './docx-roster.js';
import { parseXlsxRoster } from './xlsx-roster.js';
import { extractRosterWithOpenAI, interpretRosterGrid, refineExtractWithOpenAI, stripInventedPii } from './roster-extract.js';
import { buildSetupProposal } from './roster-setup.js';
import { logInfo, logError } from './logger.js';

function extOf(fileName) {
    const m = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
}

export function sniffRosterKind(buffer, fileName = '') {
    const ext = extOf(fileName);
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B) return ext === 'xlsx' ? 'xlsx' : (ext === 'docx' ? 'docx' : 'zip');
    if (b.length >= 8 && b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) {
        if (ext === 'xls') return 'xls';
        if (ext === 'doc') return 'doc';
        return 'ole';
    }
    if (b.length >= 4 && b.slice(0, 4).toString('utf8') === '%PDF') return 'pdf';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (b.length >= 12 && b.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
    if (ext === 'xlsx' || ext === 'docx' || ext === 'pdf' || ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') {
        if (ext === 'jpg') return 'jpeg';
        return ext;
    }
    return 'unknown';
}

async function resolveZipKind(buffer, guessed) {
    if (guessed === 'docx' || guessed === 'xlsx') return guessed;
    try {
        const zip = await JSZip.loadAsync(buffer);
        if (zip.file('xl/workbook.xml')) return 'xlsx';
        if (zip.file('word/document.xml')) return 'docx';
    } catch {
        /* ignore */
    }
    return guessed;
}

export async function extractRosterPreview({ buffer, fileName }) {
    const t0 = Date.now();
    let kind = sniffRosterKind(buffer, fileName);
    if (kind === 'zip') kind = await resolveZipKind(buffer, kind);

    logInfo('ROSTER_EXTRACT', 'Preview start', {
        fileName: fileName || '',
        kind,
        bytes: buffer?.length || 0,
    });
    console.log(`[ROSTER_EXTRACT] start kind=${kind} file=${fileName || ''} bytes=${buffer?.length || 0}`);

    if (kind === 'xls') {
        throw new Error('Save the workbook as .xlsx (Excel Workbook) and upload again');
    }
    if (kind === 'doc' || kind === 'ole') {
        throw new Error('Save as .docx, or upload a PDF or photo of the roster');
    }

    try {
        if (kind === 'docx' || kind === 'xlsx') {
            const parseT0 = Date.now();
            const parsed = kind === 'docx' ? await parseDocxRoster(buffer) : await parseXlsxRoster(buffer);
            logInfo('ROSTER_EXTRACT', 'Local parse done', {
                kind,
                durationMs: Date.now() - parseT0,
                rows: parsed?.rows?.length || 0,
                days: parsed?.days?.length || 0,
                title: parsed?.title || '',
            });
            console.log(`[ROSTER_EXTRACT] local parse ${kind} in ${Date.now() - parseT0}ms rows=${parsed?.rows?.length || 0}`);
            if (!parsed.rows?.length) throw new Error('No staff rows found in that roster');
            const interpreted = interpretRosterGrid(parsed);
            // Local-first: only call OpenAI refine when codes/meaning look uncertain
            const proposalProbe = buildSetupProposal(interpreted, null);
            const needsRefine = proposalProbe.codes.some(
                (c) => c.confidence === 'low' || !c.meaning
            ) || !(interpreted.staff || []).every((s) => s.firstName || s.lastName);
            const refined = needsRefine
                ? await refineExtractWithOpenAI(parsed, interpreted)
                : { ...interpreted, aiUsed: false };
            if (!needsRefine) {
                logInfo('ROSTER_EXTRACT', 'Skipped AI refine — high-confidence local parse', {
                    codes: proposalProbe.codes.length,
                });
            }
            const stripped = stripInventedPii(refined);
            const out = withSetupProposal(stripped, {
                kind,
                fileName: fileName || '',
                durationMs: Date.now() - t0,
                path: needsRefine ? 'local+openai-refine' : 'local-only',
                aiUsed: Boolean(refined?.aiUsed),
                openai: refined?.openaiDebug || null,
                skippedRefine: !needsRefine,
            });
            logInfo('ROSTER_EXTRACT', 'Preview done (grid+AI refine)', {
                kind,
                durationMs: Date.now() - t0,
                staff: out?.staff?.length || 0,
                days: out?.days?.length || 0,
                codes: out?.codes?.length || 0,
                aiUsed: out?.extractDebug?.aiUsed,
            });
            console.log(`[ROSTER_EXTRACT] done in ${Date.now() - t0}ms staff=${out?.staff?.length || 0} ai=${out?.extractDebug?.aiUsed}`);
            return out;
        }

        if (kind === 'pdf' || kind === 'png' || kind === 'jpeg' || kind === 'webp') {
            const preview = await extractRosterWithOpenAI({ kind, buffer, fileName });
            if (!preview.staff?.length) throw new Error('No staff rows found in that roster');
            const stripped = stripInventedPii(preview);
            const out = withSetupProposal(stripped, {
                kind,
                fileName: fileName || '',
                durationMs: Date.now() - t0,
                path: 'openai-vision',
                aiUsed: true,
                openai: preview?.openaiDebug || null,
            });
            logInfo('ROSTER_EXTRACT', 'Preview done (vision/PDF)', {
                kind,
                durationMs: Date.now() - t0,
                staff: out?.staff?.length || 0,
                days: out?.days?.length || 0,
                codes: out?.codes?.length || 0,
                aiUsed: true,
            });
            console.log(`[ROSTER_EXTRACT] done in ${Date.now() - t0}ms staff=${out?.staff?.length || 0} ai=true`);
            return out;
        }
    } catch (err) {
        logError('ROSTER_EXTRACT', `Preview failed after ${Date.now() - t0}ms`, err);
        console.error(`[ROSTER_EXTRACT] failed after ${Date.now() - t0}ms`, err.message);
        throw err;
    }

    throw new Error('Upload a Word, Excel, PDF, or photo of the duty roster');
}

function withSetupProposal(preview, extractDebug = null) {
    const proposal = buildSetupProposal(preview, null);
    const needingConfirm = (proposal.codes || []).filter((c) => c.needsConfirm || !c.meaning);
    return {
        ...preview,
        codes: proposal.codes,
        legendDraft: proposal.legendDraft,
        roleGuesses: proposal.roleGuesses,
        blanks: proposal.blanks,
        needsFullSetup: proposal.needsFullSetup,
        aiUsed: Boolean(extractDebug?.aiUsed ?? preview?.aiUsed),
        extractDebug: {
            ...(extractDebug || {}),
            staffCount: preview?.staff?.length || 0,
            dayCount: preview?.days?.length || 0,
            codeCount: proposal.codes?.length || 0,
            needingConfirm: needingConfirm.map((c) => c.label),
            needingConfirmCount: needingConfirm.length,
        },
    };
}
