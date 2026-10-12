import { expandRank, splitFullName, splitNameAndRank } from './rank-abbr.js';
import { logInfo, logError } from './logger.js';

function summarizeOpenAiPayload(data) {
    if (!data || typeof data !== 'object') return {};
    const usage = data.usage || data.usage_metadata || null;
    const id = data.id || null;
    const model = data.model || null;
    const status = data.status || null;
    const outputPreview = outputTextFromResponse(data);
    return {
        id,
        model,
        status,
        usage,
        outputChars: outputPreview ? outputPreview.length : 0,
        outputPreview: outputPreview ? outputPreview.slice(0, 800) : '',
        toolCalls: Array.isArray(data.output)
            ? data.output.filter((o) => o?.type === 'web_search_call' || o?.type === 'function_call').length
            : 0,
    };
}

const SHIFT_ALIASES = {
    M: 'Morning',
    MORNING: 'Morning',
    'MORNING DUTY': 'Morning',
    DAY: 'Morning',
    D: 'Morning',
    A: 'Afternoon',
    AFTERNOON: 'Afternoon',
    'AFTERNOON DUTY': 'Afternoon',
    EVENING: 'Afternoon',
    E: 'Afternoon',
    N: 'Night',
    NIGHT: 'Night',
    'NIGHT DUTY': 'Night',
    N12: 'Night',
    O: 'Off',
    OFF: 'Off',
    'OFF DUTY': 'Off',
    'D/O': 'Off',
    DO: 'Off',
    'N/O': 'Off',
    NOFF: 'Off',
    H: 'Holiday',
    'H/O': 'Holiday',
    HO: 'Holiday',
    PH: 'Holiday',
    SOD: 'SOD',
    OFC: 'Office',
    OFFICE: 'Office',
    LV: 'Leave',
    AL: 'Leave',
    SL: 'Leave',
    L: 'Leave',
    PTO: 'Leave',
    XM: 'Morning',
    XA: 'Afternoon',
    XN: 'Night',
    PM: 'Morning',
    PA: 'Afternoon',
    PN: 'Night',
};

function unitFromCellText(raw) {
    const u = String(raw || '').toUpperCase().replace(/\s+/g, '');
    if (!u) return '';
    if (u === 'P' || u.startsWith('P')) return 'Polyclinic X-ray';
    if (u.startsWith('X') && u.length >= 2) return 'General X-ray';
    return '';
}

function normalizeCellCode(raw, legend) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const upper = text.toUpperCase().replace(/\s+/g, ' ');
    const compact = upper.replace(/\s+/g, '');
    if (upper === 'D/O' || upper === 'N/O' || upper === 'H/O') {
        return SHIFT_ALIASES[upper];
    }
    if (upper === 'DAY SUP' || upper === 'DAYSUP') return 'Morning';
    if (legend?.length) {
        const hit = legend.find((l) => String(l.label || '').toUpperCase() === upper);
        if (hit?.meaning && !['General X-ray', 'Polyclinic X-ray'].includes(hit.meaning)) return hit.meaning;
    }
    if (compact === 'P') return '';
    if (SHIFT_ALIASES[upper]) return SHIFT_ALIASES[upper];
    if (SHIFT_ALIASES[compact]) return SHIFT_ALIASES[compact];
    return '';
}

function codeLetter(meaning) {
    if (meaning === 'Morning') return 'M';
    if (meaning === 'Afternoon') return 'A';
    if (meaning === 'Night') return 'N';
    if (meaning === 'Off') return 'O';
    if (meaning === 'Holiday') return 'H';
    if (meaning === 'SOD') return 'SOD';
    if (meaning === 'Office') return 'OFC';
    if (meaning === 'Leave') return 'LV';
    return '';
}

export function interpretRosterGrid(parsed) {
    const staff = parsed.rows.map((row) => {
        const split = splitNameAndRank(row.name);
        const names = splitFullName(split.name || row.name);
        const ranks = expandRank(row.rank || split.rank);
        const leaveType = row.leaveType || '';
        const joinedLetters = (row.cells || []).map((c) => c.text).join('').replace(/[^A-Za-z]/g, '').toUpperCase();
        const fullLeaveRow = Boolean(leaveType) && /MATERNITYLEAVE|STUDYLEAVE/.test(joinedLetters);
        const assignments = [];
        const cells = [];

        for (const cell of row.cells) {
            if (!cell.date) continue;
            const meaning = normalizeCellCode(cell.text, parsed.legend);
            const compact = String(cell.text || '').toUpperCase().replace(/\s+/g, '');
            const exactDuty = /^(XM|XA|XN|PM|PA|PN|SOD|OFC|OFFICE|D\/O|N\/O|H\/O|OFF)$/i.test(compact)
                || /^[MANOH]$/i.test(compact);
            if (fullLeaveRow || (leaveType && !exactDuty && compact !== 'L')) {
                cells.push({ date: cell.date, code: 'LV', sod: false, text: cell.text, unit: unitFromCellText(cell.text) });
                continue;
            }
            const code = codeLetter(meaning);
            const sod = Boolean(cell.sod) || meaning === 'SOD';
            const unit = unitFromCellText(cell.text);
            cells.push({ date: cell.date, code, sod, text: cell.text, unit });
            if (meaning === 'Morning' || meaning === 'Afternoon' || meaning === 'Night' || meaning === 'SOD' || meaning === 'Office') {
                assignments.push({ date: cell.date, code: codeLetter(meaning === 'SOD' ? 'SOD' : meaning), sod });
            }
        }

        return {
            no: row.no,
            fullName: `${names.firstName} ${names.lastName}`.trim() || row.name,
            firstName: names.firstName,
            lastName: names.lastName,
            rankAbbr: ranks.rankAbbr,
            rankFull: ranks.rankFull || row.rank || split.rank || '',
            selected: true,
            wardRole: ranks.rankAbbr === 'AMPS' || ranks.rankAbbr === 'PMO' || ranks.rankAbbr === 'PNO' ? 'incharge' : 'regular',
            leaveType,
            leaveNote: leaveType ? `${leaveType} leave` : '',
            cells,
            assignments: assignments,
        };
    });

    return {
        source: 'roster',
        title: parsed.title,
        unit: parsed.unit,
        month: parsed.month,
        year: parsed.year,
        days: parsed.days,
        legend: parsed.legend,
        staff,
        aiUsed: false,
    };
}

const EXTRACT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        staff: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    no: { type: 'string' },
                    firstName: { type: 'string' },
                    lastName: { type: 'string' },
                    rankAbbr: { type: 'string' },
                    rankFull: { type: 'string' },
                    leaveType: { type: 'string' },
                    leaveNote: { type: 'string' },
                    wardRole: { type: 'string' },
                    cells: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                date: { type: 'string' },
                                code: { type: 'string' },
                                sod: { type: 'boolean' },
                                text: { type: 'string' },
                                unit: { type: 'string' },
                            },
                            required: ['date', 'code', 'sod', 'text', 'unit'],
                        },
                    },
                },
                required: ['no', 'firstName', 'lastName', 'rankAbbr', 'rankFull', 'leaveType', 'leaveNote', 'wardRole', 'cells'],
            },
        },
    },
    required: ['staff'],
};

function ghanaLegendPrompt() {
    return `Ghana hospital duty-roster contract:
- Delivery Suite letters: M morning, A afternoon, N night, O off, H holiday
- Weekend column shading is not a shift
- SOD is a flag, not a new shift unless the cell text is SOD
- DAY SUP is morning + supervisor
- Leave spelled across cells (MATERNITY LEAVE, PART LEAVE, STUDY LEAVE) is a leave note, not M/A/N
- Aliases: D/O N/O H/O = off/holiday; E = afternoon; Day (not D/O) = morning
- Radiology (Cape Coast and similar): M/A/N are shifts. X means General X-ray (unit prefix). P means Polyclinic / office hours (NOT afternoon) — map as Office (OFC, ~08:00–14:00) with unit Polyclinic X-ray. XM/XA/XN = ward shift at General X-ray. L = leave. O = off.
- Expand GHS rank codes (SSM=Senior Staff Midwife, AMPS, SMO, MO, SM, SSN, RM, PMO, PNO, SNO, NO, DCNO, DNMS)
- Never output Ghana Card, staff ID, or license numbers
- Title-case names; first token is firstName, remainder lastName
- Cell code in JSON must be M A N O H LV SOD OFC or empty. Put unit on "unit" (General X-ray / Polyclinic X-ray / empty). Keep original letters in "text".
- If a rank, unit letter, or shift slang is unknown, use web search with Ghana health keywords (Ghana Health Service, GHS, duty roster, plus the token). Prefer GHS / MoH / teaching-hospital pages. At most a few searches. If still unknown, leave code empty and keep the raw text for human review — do not invent a meaning.`;
}

function buildPrompt(parsed, interpreted) {
    return `You extract Ghana hospital duty-roster data. Return JSON only.

This file's legend (trust first if present):
${JSON.stringify(parsed.legend, null, 0)}

${ghanaLegendPrompt()}

Parsed grid (already split into staff rows and dates):
${JSON.stringify({
        title: parsed.title,
        unit: parsed.unit,
        month: parsed.month,
        year: parsed.year,
        days: parsed.days,
        staff: interpreted.staff.map((s) => ({
            no: s.no,
            name: s.fullName,
            rank: s.rankAbbr,
            leaveType: s.leaveType,
            cells: s.cells.map((c) => ({ date: c.date, text: c.text, code: c.code, sod: c.sod, unit: c.unit || '' })),
        })),
    })}

Correct names, ranks, leave, units, and cell codes. Keep one staff object per input row.`;
}

const FULL_EXTRACT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        title: { type: 'string' },
        unit: { type: 'string' },
        month: { type: 'string' },
        year: { type: 'integer' },
        days: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    date: { type: 'string' },
                    dayNum: { type: 'integer' },
                    dow: { type: 'string' },
                    weekend: { type: 'boolean' },
                },
                required: ['date', 'dayNum', 'dow', 'weekend'],
            },
        },
        legend: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    label: { type: 'string' },
                    meaning: { type: 'string' },
                },
                required: ['label', 'meaning'],
            },
        },
        staff: EXTRACT_SCHEMA.properties.staff,
    },
    required: ['title', 'unit', 'month', 'year', 'days', 'legend', 'staff'],
};

function outputTextFromResponse(data) {
    if (data?.output_text) return data.output_text;
    const chunks = [];
    for (const item of data?.output || []) {
        if (item?.type !== 'message') continue;
        for (const c of item.content || []) {
            if (c?.type === 'output_text' || c?.type === 'text') chunks.push(c.text || '');
        }
    }
    if (chunks.length) return chunks.join('\n');
    const legacy = data?.choices?.[0]?.message?.content;
    return typeof legacy === 'string' ? legacy : '';
}

async function openaiResponses({ key, input, schema, schemaName, timeoutMs = 90000, logCtx = {} }) {
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const t0 = Date.now();
    const inputSummary = Array.isArray(input)
        ? input.map((msg) => ({
            role: msg.role,
            contentTypes: Array.isArray(msg.content)
                ? msg.content.map((c) => c?.type || typeof c)
                : typeof msg.content,
            textChars: Array.isArray(msg.content)
                ? msg.content.reduce((n, c) => n + String(c?.text || '').length, 0)
                : String(msg.content || '').length,
        }))
        : { type: typeof input };
    logInfo('OPENAI', 'Responses API request start', {
        endpoint: '/v1/responses',
        model,
        schemaName,
        timeoutMs,
        inputSummary,
        ...logCtx,
    });
    console.log(`[OPENAI] → responses ${schemaName} model=${model} timeout=${timeoutMs}ms`, logCtx);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                temperature: 0,
                tools: [{ type: 'web_search' }],
                max_tool_calls: 3,
                text: {
                    format: {
                        type: 'json_schema',
                        name: schemaName,
                        strict: true,
                        schema,
                    },
                },
                input,
            }),
            signal: controller.signal,
        });
        const durationMs = Date.now() - t0;
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            logError('OPENAI', `Responses API failed ${res.status}`, {
                message: errText.slice(0, 500),
                status: res.status,
                durationMs,
                schemaName,
                ...logCtx,
            });
            console.error(`[OPENAI] ← responses FAIL ${res.status} in ${durationMs}ms`, errText.slice(0, 300));
            const err = new Error(`OpenAI ${res.status}: ${errText.slice(0, 500)}`);
            err.status = res.status;
            err.body = errText;
            throw err;
        }
        const data = await res.json();
        const content = outputTextFromResponse(data);
        const summary = summarizeOpenAiPayload(data);
        logInfo('OPENAI', 'Responses API success', {
            durationMs,
            schemaName,
            httpStatus: res.status,
            ...summary,
            ...logCtx,
        });
        console.log(`[OPENAI] ← responses OK in ${durationMs}ms`, {
            id: summary.id,
            usage: summary.usage,
            outputChars: summary.outputChars,
            toolCalls: summary.toolCalls,
        });
        if (!content) throw new Error('OpenAI returned no text');
        return JSON.parse(content);
    } catch (err) {
        if (err?.name === 'AbortError') {
            const durationMs = Date.now() - t0;
            logError('OPENAI', 'Responses API aborted (timeout)', { durationMs, schemaName, timeoutMs, ...logCtx });
            console.error(`[OPENAI] ← responses TIMEOUT after ${durationMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function openaiChatFallback({ key, messages, schema, schemaName, timeoutMs = 90000, logCtx = {} }) {
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const t0 = Date.now();
    logInfo('OPENAI', 'Chat completions fallback start', {
        endpoint: '/v1/chat/completions',
        model,
        schemaName,
        timeoutMs,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        ...logCtx,
    });
    console.log(`[OPENAI] → chat/completions ${schemaName} model=${model}`, logCtx);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                temperature: 0,
                response_format: {
                    type: 'json_schema',
                    json_schema: { name: schemaName, strict: true, schema },
                },
                messages,
            }),
            signal: controller.signal,
        });
        const durationMs = Date.now() - t0;
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            logError('OPENAI', `Chat API failed ${res.status}`, {
                message: errText.slice(0, 400),
                status: res.status,
                durationMs,
                schemaName,
                ...logCtx,
            });
            console.error(`[OPENAI] ← chat FAIL ${res.status} in ${durationMs}ms`, errText.slice(0, 300));
            throw new Error(`OpenAI chat ${res.status}: ${errText.slice(0, 400)}`);
        }
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        logInfo('OPENAI', 'Chat completions success', {
            durationMs,
            schemaName,
            httpStatus: res.status,
            model: data.model,
            usage: data.usage || null,
            outputChars: content ? content.length : 0,
            outputPreview: content ? String(content).slice(0, 800) : '',
            ...logCtx,
        });
        console.log(`[OPENAI] ← chat OK in ${durationMs}ms`, { usage: data.usage, outputChars: content?.length });
        if (!content) throw new Error('OpenAI returned no text');
        return JSON.parse(content);
    } catch (err) {
        if (err?.name === 'AbortError') {
            const durationMs = Date.now() - t0;
            logError('OPENAI', 'Chat API aborted (timeout)', { durationMs, schemaName, timeoutMs, ...logCtx });
            console.error(`[OPENAI] ← chat TIMEOUT after ${durationMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

export async function refineExtractWithOpenAI(parsed, interpreted) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
        logInfo('OPENAI', 'Refine skipped — OPENAI_API_KEY not set');
        return interpreted;
    }
    const prompt = buildPrompt(parsed, interpreted);
    const logCtx = {
        stage: 'refine',
        title: parsed?.title || '',
        rowCount: parsed?.rows?.length || 0,
        dayCount: parsed?.days?.length || 0,
        promptChars: prompt.length,
        promptPreview: prompt.slice(0, 600),
    };
    logInfo('OPENAI', 'Refine extract start', logCtx);
    console.log('[OPENAI] refine start', { rows: logCtx.rowCount, days: logCtx.dayCount, promptChars: logCtx.promptChars });
    const t0 = Date.now();
    try {
        let parsedAi;
        try {
            parsedAi = await openaiResponses({
                key,
                schema: EXTRACT_SCHEMA,
                schemaName: 'roster_extract',
                logCtx,
                input: [
                    { role: 'system', content: 'You convert duty-roster grids into structured staff and shift cells. No IDs.' },
                    { role: 'user', content: prompt },
                ],
            });
        } catch (err) {
            console.warn('[OPENAI] responses refine failed, using chat', err.message);
            logInfo('OPENAI', 'Refine falling back to chat', { error: err.message, ...logCtx });
            parsedAi = await openaiChatFallback({
                key,
                schema: EXTRACT_SCHEMA,
                schemaName: 'roster_extract',
                logCtx: { ...logCtx, fallback: true },
                messages: [
                    { role: 'system', content: 'You convert duty-roster grids into structured staff and shift cells. No IDs.' },
                    { role: 'user', content: prompt },
                ],
            });
        }
        const merged = mergeAiExtract(interpreted, parsedAi);
        const durationMs = Date.now() - t0;
        logInfo('OPENAI', 'Refine extract done', {
            durationMs,
            staffOut: merged?.staff?.length || 0,
            ...logCtx,
        });
        console.log(`[OPENAI] refine done in ${durationMs}ms staff=${merged?.staff?.length || 0}`);
        return {
            ...merged,
            openaiDebug: {
                stage: 'refine',
                durationMs,
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                staffOut: merged?.staff?.length || 0,
            },
        };
    } catch (err) {
        logError('OPENAI', 'Refine extract skipped', err);
        console.warn('[OPENAI] refine skipped', err.message);
        return {
            ...interpreted,
            aiUsed: false,
            openaiDebug: { stage: 'refine', skipped: true, error: err.message },
        };
    }
}

function mimeForKind(kind) {
    if (kind === 'png') return 'image/png';
    if (kind === 'jpeg') return 'image/jpeg';
    if (kind === 'webp') return 'image/webp';
    if (kind === 'pdf') return 'application/pdf';
    return 'application/octet-stream';
}

async function uploadOpenAiFile(key, buffer, fileName, mime) {
    const t0 = Date.now();
    logInfo('OPENAI', 'File upload start', {
        endpoint: '/v1/files',
        fileName,
        mime,
        bytes: buffer?.length || 0,
    });
    console.log(`[OPENAI] → files upload ${fileName} ${mime} ${buffer?.length || 0}B`);
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob([buffer], { type: mime }), fileName || 'roster.bin');
    const res = await fetch('https://api.openai.com/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
    });
    const durationMs = Date.now() - t0;
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        logError('OPENAI', `File upload failed ${res.status}`, {
            message: errText.slice(0, 300),
            status: res.status,
            durationMs,
            fileName,
            mime,
        });
        console.error(`[OPENAI] ← files FAIL ${res.status} in ${durationMs}ms`);
        throw new Error(`OpenAI file upload ${res.status}: ${errText.slice(0, 300)}`);
    }
    const json = await res.json();
    logInfo('OPENAI', 'File upload success', {
        durationMs,
        fileId: json.id,
        bytes: json.bytes,
        purpose: json.purpose,
        fileName,
    });
    console.log(`[OPENAI] ← files OK in ${durationMs}ms id=${json.id}`);
    return json;
}

export async function extractRosterWithOpenAI({ kind, buffer, fileName }) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
        throw new Error('AI extract is not configured. Set OPENAI_API_KEY to read PDFs and photos.');
    }
    const mime = mimeForKind(kind);
    const logCtx = {
        stage: 'vision_extract',
        kind,
        fileName: fileName || '',
        bytes: buffer?.length || 0,
        mime,
    };
    logInfo('OPENAI', 'Vision/PDF extract start', logCtx);
    console.log('[OPENAI] vision extract start', logCtx);
    const t0 = Date.now();
    const instruction = `Extract every staff row and each day's shift from this Ghana hospital duty roster (${fileName || kind}).
${ghanaLegendPrompt()}
Return JSON only. year must be a 4-digit number. days[].date is YYYY-MM-DD.`;

    const userContent = [{ type: 'input_text', text: instruction }];
    if (kind === 'pdf') {
        const uploaded = await uploadOpenAiFile(key, buffer, fileName || 'roster.pdf', mime);
        userContent.push({ type: 'input_file', file_id: uploaded.id });
        logCtx.fileId = uploaded.id;
    } else {
        userContent.push({
            type: 'input_image',
            image_url: `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`,
        });
    }

    let parsedAi;
    try {
        parsedAi = await openaiResponses({
            key,
            schema: FULL_EXTRACT_SCHEMA,
            schemaName: 'roster_vision_extract',
            timeoutMs: 120000,
            logCtx,
            input: [
                { role: 'system', content: [{ type: 'input_text', text: 'You extract Ghana duty rosters. No IDs.' }] },
                { role: 'user', content: userContent },
            ],
        });
    } catch (err) {
        console.warn('[OPENAI] vision responses failed, trying chat image', err.message);
        logInfo('OPENAI', 'Vision falling back to chat', { error: err.message, ...logCtx });
        if (kind === 'pdf') throw new Error('Could not read that PDF. Photograph the roster page and upload the image, or save as Word/Excel.');
        parsedAi = await openaiChatFallback({
            key,
            schema: FULL_EXTRACT_SCHEMA,
            schemaName: 'roster_vision_extract',
            timeoutMs: 120000,
            logCtx: { ...logCtx, fallback: true },
            messages: [
                { role: 'system', content: 'You extract Ghana duty rosters. No IDs.' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: instruction },
                        { type: 'image_url', image_url: { url: `data:${mime};base64,${Buffer.from(buffer).toString('base64')}` } },
                    ],
                },
            ],
        });
    }
    logInfo('OPENAI', 'Vision/PDF raw extract received', {
        durationMs: Date.now() - t0,
        staffCount: parsedAi?.staff?.length || 0,
        dayCount: parsedAi?.days?.length || 0,
        title: parsedAi?.title || '',
        ...logCtx,
    });
    console.log(`[OPENAI] vision raw done in ${Date.now() - t0}ms staff=${parsedAi?.staff?.length || 0}`);

    const days = (parsedAi.days || []).map((d) => ({
        date: d.date,
        dayNum: d.dayNum,
        dow: d.dow || '',
        weekend: Boolean(d.weekend),
    }));
    const dummyParsed = {
        title: parsedAi.title || '',
        unit: parsedAi.unit || '',
        month: parsedAi.month || '',
        year: parsedAi.year || null,
        days,
        legend: parsedAi.legend || [],
        rows: (parsedAi.staff || []).map((s, i) => ({
            no: s.no || String(i + 1),
            name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
            rank: s.rankFull || s.rankAbbr || '',
            leaveType: s.leaveType || '',
            cells: (s.cells || []).map((c) => ({
                text: c.text || c.code || '',
                fill: '',
                fontColor: '',
                date: c.date,
                sod: Boolean(c.sod),
                leaveFill: c.code === 'LV',
            })),
        })),
    };
    const interpreted = interpretRosterGrid(dummyParsed);
    const merged = mergeAiExtract(interpreted, parsedAi);
    return {
        ...merged,
        openaiDebug: {
            stage: 'vision_extract',
            kind,
            fileName: fileName || '',
            durationMs: Date.now() - t0,
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            staffOut: merged?.staff?.length || 0,
        },
    };
}

function mergeAiExtract(base, ai) {
    const byNo = new Map((ai.staff || []).map((s) => [String(s.no), s]));
    const staff = base.staff.map((row) => {
        const extra = byNo.get(String(row.no));
        if (!extra) return row;
        const cells = (extra.cells?.length ? extra.cells : row.cells).map((c, i) => ({
            date: c.date,
            code: String(c.code || '').toUpperCase(),
            sod: Boolean(c.sod),
            text: c.text || row.cells[i]?.text || c.code || '',
            unit: c.unit || row.cells[i]?.unit || unitFromCellText(c.text || row.cells[i]?.text || ''),
        }));
        const leaveType = extra.leaveType || row.leaveType || '';
        const assignments = cells
            .filter((c) => ['M', 'A', 'N', 'SOD'].includes(c.code))
            .map((c) => ({ date: c.date, code: c.code, sod: c.sod || c.code === 'SOD' }));
        return {
            ...row,
            firstName: extra.firstName || row.firstName,
            lastName: extra.lastName || row.lastName,
            fullName: `${extra.firstName || row.firstName} ${extra.lastName || row.lastName}`.trim(),
            rankAbbr: extra.rankAbbr || row.rankAbbr,
            // Prefer any non-empty rank from AI or local parse; expand abbrs like SSN → Senior Staff Nurse
            rankFull: expandRank(
                extra.rankFull || row.rankFull || extra.rankAbbr || row.rankAbbr || ''
            ).rankFull || extra.rankFull || row.rankFull || '',
            leaveType,
            leaveNote: extra.leaveNote || row.leaveNote,
            wardRole: extra.wardRole === 'incharge' || extra.wardRole === 'assistant' ? extra.wardRole : row.wardRole,
            cells,
            assignments,
        };
    });
    return { ...base, staff, aiUsed: true };
}

const PII_RE = /ghana\s*card|license\s*(number|no)|employee\s*id|pin\s*-|ain\s*-/i;

export function stripInventedPii(preview) {
    return {
        ...preview,
        staff: (preview.staff || []).map((s) => {
            const clone = { ...s };
            for (const k of Object.keys(clone)) {
                if (PII_RE.test(k) || PII_RE.test(String(clone[k] || ''))) {
                    if (['firstName', 'lastName', 'fullName', 'rankAbbr', 'rankFull', 'leaveNote'].includes(k)) continue;
                    if (typeof clone[k] === 'string' && PII_RE.test(clone[k]) && !['firstName', 'lastName', 'fullName'].includes(k)) {
                        clone[k] = '';
                    }
                }
            }
            delete clone.ghanaCardNumber;
            delete clone.employeeId;
            delete clone.licenseNumber;
            return clone;
        }),
    };
}
