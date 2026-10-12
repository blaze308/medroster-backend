/** Build ward roster setup proposals + remap without calling OpenAI. */

/** All MedRoster cell meanings — keep in sync with applyRosterSetup / codeLetter. */
export const LEGEND_MEANING_OPTIONS = [
    { value: 'Morning', label: 'Morning', hint: 'Day shift · M, XM, D', group: 'On duty' },
    { value: 'Afternoon', label: 'Afternoon', hint: 'A, XA, E', group: 'On duty' },
    { value: 'Night', label: 'Night', hint: 'N, XN, N12', group: 'On duty' },
    { value: 'SOD', label: 'SOD', hint: 'Supervisor on Duty', group: 'On duty' },
    { value: 'Office', label: 'Office', hint: 'Weekdays 08:00–14:00 · P / Polyclinic', group: 'On duty' },
    { value: 'Off', label: 'Off', hint: 'O, D/O, OFF', group: 'Not on duty' },
    { value: 'Holiday', label: 'Holiday', hint: 'H, H/O, PH', group: 'Not on duty' },
    { value: 'Leave', label: 'Leave', hint: 'L, LV, annual / maternity', group: 'Not on duty' },
];

export const LEGEND_MEANINGS = LEGEND_MEANING_OPTIONS.map((o) => o.value);

/** Cover shifts a duty can overlap / hand off to. */
export const DUTY_OVERLAP_OPTIONS = [
    { value: 'Morning', label: 'Morning', hint: 'Day session · Office 8–2 typically sits here' },
    { value: 'Afternoon', label: 'Afternoon', hint: 'Take-up after the morning session' },
    { value: 'Night', label: 'Night', hint: 'Evening / night take-up' },
];

export const DUTY_OVERLAP_SHIFTS = DUTY_OVERLAP_OPTIONS.map((o) => o.value);
export const ON_DUTY_MEANINGS = ['Morning', 'Afternoon', 'Night', 'SOD', 'Office'];

/** Office-style: Morning only — daily 8–2, overlaps Morning but separate, no take-ups. */
export function defaultDutyOverlaps(meaning) {
    if (!ON_DUTY_MEANINGS.includes(meaning)) return [];
    if (meaning === 'Office' || meaning === 'Morning' || meaning === 'SOD') return ['Morning'];
    if (meaning === 'Afternoon') return ['Afternoon'];
    if (meaning === 'Night') return ['Night'];
    return ['Morning'];
}

/** Migrate legacy dutyMode → overlaps. */
function overlapsFromLegacyMode(dutyMode, meaning) {
    if (dutyMode === 'standard') return [...DUTY_OVERLAP_SHIFTS];
    if (dutyMode === 'office' || dutyMode === 'morningLike') return ['Morning'];
    return defaultDutyOverlaps(meaning);
}

export function normalizeDutyOverlaps(raw, meaning, legacyMode = '') {
    if (!ON_DUTY_MEANINGS.includes(meaning)) return [];
    let list = Array.isArray(raw) ? raw.map((v) => String(v || '').trim()) : [];
    list = list.filter((v) => DUTY_OVERLAP_SHIFTS.includes(v));
    if (!list.length && legacyMode) list = overlapsFromLegacyMode(legacyMode, meaning);
    if (!list.length) list = defaultDutyOverlaps(meaning);
    // Stable order: Morning → Afternoon → Night
    return DUTY_OVERLAP_SHIFTS.filter((s) => list.includes(s));
}

/** Tagged every cover shift → treat as a regular cover shift. */
export function isRegularDutyOverlaps(overlaps) {
    const set = new Set(overlaps || []);
    return DUTY_OVERLAP_SHIFTS.every((s) => set.has(s));
}

/**
 * Office-style post: Morning-only overlaps (8–2, separate from Morning, no take-ups).
 * Expanding overlaps means hand-off / take-up after the session.
 */
export function isOfficeStyleOverlaps(meaning, overlaps) {
    if (isRegularDutyOverlaps(overlaps)) return false;
    const list = overlaps || [];
    return meaning === 'Office' && list.length === 1 && list[0] === 'Morning';
}

const KNOWN_LABEL_MEANING = {
    M: 'Morning',
    A: 'Afternoon',
    N: 'Night',
    O: 'Off',
    H: 'Holiday',
    L: 'Leave',
    LV: 'Leave',
    SOD: 'SOD',
    OFC: 'Office',
    OFFICE: 'Office',
    XM: 'Morning',
    XA: 'Afternoon',
    XN: 'Night',
    PM: 'Morning',
    PA: 'Afternoon',
    PN: 'Night',
    OFF: 'Off',
    P: '', // Polyclinic / office hours — soft-suggest Office
};

function normalizeLabel(raw) {
    return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
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

function unitFromLabel(label) {
    const u = normalizeLabel(label);
    if (!u) return '';
    if (u === 'P' || (u.startsWith('P') && u.length <= 3)) return 'Polyclinic X-ray';
    if (u.startsWith('X') && u.length >= 2) return 'General X-ray';
    return '';
}

function confidenceFor(label, meaning, fromSaved) {
    if (fromSaved) return 'high';
    if (!meaning) return 'low';
    if (KNOWN_LABEL_MEANING[normalizeLabel(label)] !== undefined && KNOWN_LABEL_MEANING[normalizeLabel(label)] === meaning) {
        return 'high';
    }
    return 'medium';
}

/**
 * Propose legend + role guesses + blanks from an extract preview.
 * @param {object} preview - extract result with staff[].cells
 * @param {object|null} savedSetup - ward.rosterSetup if any
 */
export function buildSetupProposal(preview, savedSetup = null) {
    const savedLegend = Array.isArray(savedSetup?.legend) ? savedSetup.legend : [];
    const savedByLabel = new Map(
        savedLegend.map((e) => [normalizeLabel(e.label || e.code), e])
    );

    const labelCounts = new Map();
    for (const s of preview?.staff || []) {
        for (const c of s.cells || []) {
            const label = normalizeLabel(c.text || c.code);
            if (!label) continue;
            labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
        }
    }

    const fileLegend = Array.isArray(preview?.legend) ? preview.legend : [];
    const fileByLabel = new Map(
        fileLegend.map((e) => [normalizeLabel(e.label || e.code), e])
    );

    const codes = [...labelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => {
            const saved = savedByLabel.get(label);
            const fromFile = fileByLabel.get(label);
            let meaning = saved?.meaning
                || fromFile?.meaning
                || KNOWN_LABEL_MEANING[label];
            if (meaning === undefined) meaning = '';
            let unit = saved?.unit || fromFile?.unit || unitFromLabel(label) || '';
            // File legends sometimes put unit text in "meaning" (e.g. P → Polyclinic X-ray)
            if (meaning && !LEGEND_MEANINGS.includes(meaning)) {
                if (!unit) unit = meaning;
                meaning = KNOWN_LABEL_MEANING[label] || '';
            }
            // Polyclinic / office-hours codes — soft-suggest Office (08:00–14:00), not ward Morning
            if (!meaning && unit && (/polyclinic/i.test(unit) || label === 'P')) {
                meaning = 'Office';
            }
            const dutyOverlaps = ON_DUTY_MEANINGS.includes(meaning)
                ? normalizeDutyOverlaps(saved?.dutyOverlaps, meaning, saved?.dutyMode)
                : [];
            const confidence = confidenceFor(label, meaning, Boolean(saved));
            // Always confirm when we only guessed from a unit / office tag
            const needsConfirm = confidence !== 'high' || !meaning
                || ((/polyclinic/i.test(unit) || meaning === 'Office') && !saved && label === 'P');
            return {
                label,
                count,
                meaning: meaning || '',
                unit,
                dutyOverlaps,
                confidence,
                needsConfirm,
                fromSaved: Boolean(saved),
            };
        });

    const legendDraft = codes.map((c) => ({
        label: c.label,
        meaning: c.meaning,
        unit: c.unit,
        dutyOverlaps: c.dutyOverlaps,
        confidence: c.confidence,
        needsConfirm: c.needsConfirm,
    }));

    const roleGuesses = (preview?.staff || []).map((s, i) => {
        const key = s.key || s.no || s._id || `row-${i}`;
        const name = `${s.firstName || ''} ${s.lastName || ''}`.trim() || s.fullName || key;
        return {
            key,
            name,
            rank: s.rankFull || s.rank || '',
            guessedRole: s.wardRole || 'regular',
            leaveType: s.leaveType || '',
            leaveLikely: Boolean(s.leaveType) || (s.cells || []).every((c) => ['L', 'LV', 'Leave'].includes(String(c.code || c.text || ''))),
        };
    });

    const hasInchargeGuess = roleGuesses.some((r) => r.guessedRole === 'incharge');
    const unknownCodes = codes.filter((c) => c.needsConfirm);
    const blanks = [];
    if (unknownCodes.length) {
        blanks.push({
            type: 'legend',
            message: `${unknownCodes.length} code${unknownCodes.length === 1 ? '' : 's'} need confirmation`,
            labels: unknownCodes.map((c) => c.label),
        });
    }
    if (!savedSetup?.inchargeStaffKey && !hasInchargeGuess) {
        blanks.push({
            type: 'incharge',
            message: 'No ward in-charge marked — pick one if you can (tip only)',
        });
    }
    if (roleGuesses.some((r) => r.leaveLikely && !r.leaveType)) {
        blanks.push({
            type: 'leave',
            message: 'Some rows look like leave — confirm leave type if known',
        });
    }

    return {
        codes,
        legendDraft,
        roleGuesses,
        blanks,
        savedSetup: savedSetup || null,
        // Re-ask only when pack missing or new unknown codes (in-charge tip is soft, not a monthly block)
        needsFullSetup: !savedSetup?.confirmedAt || unknownCodes.length > 0,
    };
}

/**
 * Remap preview staff cells/assignments using a confirmed legend + role picks.
 * Pure — no OpenAI.
 */
export function applyRosterSetup(preview, setup = {}) {
    const legend = Array.isArray(setup.legend) ? setup.legend : [];
    const byLabel = new Map(
        legend.map((e) => [normalizeLabel(e.label || e.code), e])
    );

    const staff = (preview?.staff || []).map((s, i) => {
        const key = s.key || s.no || s._id || `row-${i}`;
        let wardRole = s.wardRole || 'regular';
        if (setup.inchargeStaffKey && String(setup.inchargeStaffKey) === String(key)) wardRole = 'incharge';
        else if (setup.assistantStaffKey && String(setup.assistantStaffKey) === String(key)) wardRole = 'assistant';
        else if (setup.inchargeStaffKey || setup.assistantStaffKey) {
            if (wardRole === 'incharge' || wardRole === 'assistant') wardRole = 'regular';
        }

        const leaveOverride = (setup.leaveByKey && setup.leaveByKey[key]) || null;
        const leaveType = leaveOverride?.leaveType || s.leaveType || '';
        const onLeave = leaveOverride?.onLeave === true || Boolean(leaveType);

        const cells = [];
        const assignments = [];
        for (const cell of s.cells || []) {
            const label = normalizeLabel(cell.text || cell.code);
            const entry = byLabel.get(label);
            const meaning = entry?.meaning || KNOWN_LABEL_MEANING[label] || '';
            const unit = entry?.unit || cell.unit || unitFromLabel(label) || '';
            const dutyOverlaps = ON_DUTY_MEANINGS.includes(meaning)
                ? normalizeDutyOverlaps(entry?.dutyOverlaps, meaning, entry?.dutyMode)
                : [];
            const code = onLeave && !meaning ? 'LV' : codeLetter(meaning) || (meaning ? '' : (cell.code || ''));
            const sod = meaning === 'SOD' || Boolean(cell.sod);
            const next = {
                date: cell.date,
                text: cell.text,
                code: onLeave && (!meaning || meaning === 'Leave') ? 'LV' : code,
                sod,
                unit,
                meaning: onLeave && (!meaning || meaning === 'Leave') ? 'Leave' : meaning,
                dutyOverlaps,
            };
            cells.push(next);
            if (ON_DUTY_MEANINGS.includes(next.meaning)) {
                assignments.push({
                    date: cell.date,
                    code: next.code,
                    sod: next.sod,
                    dutyOverlaps: next.dutyOverlaps,
                });
            }
        }

        return {
            ...s,
            key,
            wardRole,
            leaveType,
            leaveNote: leaveType
                ? (/leave$/i.test(String(leaveType).trim())
                    ? String(leaveType).trim().replace(/^\w/, (c) => c.toUpperCase())
                    : `${String(leaveType).charAt(0).toUpperCase()}${String(leaveType).slice(1)} leave`)
                : (s.leaveNote || ''),
            cells,
            assignments,
            selected: s.selected !== false,
        };
    });

    return {
        ...preview,
        staff,
        legend: legend.map((e) => ({
            label: e.label,
            meaning: e.meaning,
            unit: e.unit || '',
            dutyOverlaps: ON_DUTY_MEANINGS.includes(e.meaning)
                ? normalizeDutyOverlaps(e.dutyOverlaps, e.meaning, e.dutyMode)
                : [],
        })),
        setupApplied: true,
    };
}

export function buildRosterSetupPayload(setup) {
    return {
        legend: (setup.legend || []).map((e) => {
            const meaning = String(e.meaning || '').trim();
            return {
                label: String(e.label || '').trim(),
                meaning,
                unit: String(e.unit || '').trim(),
                dutyOverlaps: ON_DUTY_MEANINGS.includes(meaning)
                    ? normalizeDutyOverlaps(e.dutyOverlaps, meaning, e.dutyMode)
                    : [],
            };
        }),
        inchargeStaffKey: setup.inchargeStaffKey || '',
        assistantStaffKey: setup.assistantStaffKey || '',
        units: setup.units || {},
        leaveByKey: setup.leaveByKey || {},
        confirmedAt: new Date().toISOString(),
    };
}
