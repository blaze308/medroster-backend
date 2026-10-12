/** Build ward roster setup proposals + remap without calling OpenAI. */

/** All MedRoster cell meanings — keep in sync with applyRosterSetup / codeLetter. */
export const LEGEND_MEANING_OPTIONS = [
    { value: 'Morning', label: 'Morning', hint: 'Ward cover · M, D', group: 'On duty' },
    { value: 'Afternoon', label: 'Afternoon', hint: 'Ward cover · A, E', group: 'On duty' },
    { value: 'Night', label: 'Night', hint: 'Ward cover · N, XN, N12', group: 'On duty' },
    { value: 'SOD', label: 'SOD', hint: 'Supervisor on Duty', group: 'On duty' },
    { value: 'Office', label: 'Office', hint: 'Clinic / office days · 8–2 · P, XM, XA', group: 'On duty' },
    { value: 'Off', label: 'Off', hint: 'O, D/O, OFF', group: 'Not on duty' },
    { value: 'Holiday', label: 'Holiday', hint: 'H, H/O, PH', group: 'Not on duty' },
    { value: 'Leave', label: 'Leave', hint: 'L, LV, annual / maternity', group: 'Not on duty' },
];

export const LEGEND_MEANINGS = LEGEND_MEANING_OPTIONS.map((o) => o.value);

/** Fixed ward cover shifts — not user-editable attach modes. */
export const COVER_SHIFTS = ['Morning', 'Afternoon', 'Night'];
export const ON_DUTY_MEANINGS = ['Morning', 'Afternoon', 'Night', 'SOD', 'Office'];

/** Clinic / office operating weekdays (Mon–Fri default, like antenatal / polyclinic). */
export const OFFICE_DAY_OPTIONS = [
    { value: 'Mon', label: 'Mon' },
    { value: 'Tue', label: 'Tue' },
    { value: 'Wed', label: 'Wed' },
    { value: 'Thu', label: 'Thu' },
    { value: 'Fri', label: 'Fri' },
    { value: 'Sat', label: 'Sat' },
    { value: 'Sun', label: 'Sun' },
];
export const OFFICE_DAY_KEYS = OFFICE_DAY_OPTIONS.map((o) => o.value);
export const DEFAULT_OFFICE_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

/** Internal cover bucket for each meaning (M/A/N fixed; Office → Morning-like). */
export function defaultDutyOverlaps(meaning) {
    if (!ON_DUTY_MEANINGS.includes(meaning)) return [];
    if (meaning === 'Afternoon') return ['Afternoon'];
    if (meaning === 'Night') return ['Night'];
    // Morning, SOD, Office → morning-like cover bucket (Office still separate / no take-ups)
    return ['Morning'];
}

export function normalizeDutyOverlaps(_raw, meaning) {
    return defaultDutyOverlaps(meaning);
}

export function defaultOfficeDays(meaning) {
    if (meaning !== 'Office') return [];
    return [...DEFAULT_OFFICE_DAYS];
}

export function normalizeOfficeDays(raw, meaning) {
    if (meaning !== 'Office') return [];
    let list = Array.isArray(raw) ? raw.map((v) => String(v || '').trim()) : [];
    list = list.filter((v) => OFFICE_DAY_KEYS.includes(v));
    if (!list.length) return defaultOfficeDays(meaning);
    return OFFICE_DAY_KEYS.filter((d) => list.includes(d));
}

/** Office is clinic-style (no take-ups) unless rare outsideMorning flag. */
export function isOfficeStyleEntry(meaning, outsideMorning = false) {
    return meaning === 'Office' && !outsideMorning;
}

export function weekdayKeyFromDate(date) {
    const keys = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return keys[new Date(date).getDay()] || '';
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
    XM: '', // often clinic/office session — soft-suggest Office
    XA: '', // often clinic/office session — soft-suggest Office
    XN: 'Night',
    PM: 'Morning',
    PA: 'Afternoon',
    PN: 'Night',
    OFF: 'Off',
    P: '', // Polyclinic / office hours — soft-suggest Office
};

function looksLikeOfficeCode(label, unit) {
    const u = String(unit || '');
    if (label === 'P' || label === 'OFC' || label === 'OFFICE') return true;
    if (label === 'XM' || label === 'XA') return true;
    if (/polyclinic|clinic|office|antenatal/i.test(u)) return true;
    return false;
}

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
            // Clinic / office-hours codes — soft-suggest Office (morning-like clinic days)
            if (!saved && looksLikeOfficeCode(label, unit) && (!meaning || meaning === 'Morning' || meaning === 'Afternoon')) {
                meaning = 'Office';
            }
            if (!meaning && looksLikeOfficeCode(label, unit)) {
                meaning = 'Office';
            }
            const dutyOverlaps = ON_DUTY_MEANINGS.includes(meaning)
                ? normalizeDutyOverlaps(saved?.dutyOverlaps, meaning)
                : [];
            const officeDays = meaning === 'Office'
                ? normalizeOfficeDays(saved?.officeDays, meaning)
                : [];
            const outsideMorning = meaning === 'Office' ? Boolean(saved?.outsideMorning) : false;
            const confidence = confidenceFor(label, meaning, Boolean(saved));
            const needsConfirm = confidence !== 'high' || !meaning
                || (!saved && meaning === 'Office' && looksLikeOfficeCode(label, unit));
            return {
                label,
                count,
                meaning: meaning || '',
                unit,
                dutyOverlaps,
                officeDays,
                outsideMorning,
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
        officeDays: c.officeDays,
        outsideMorning: c.outsideMorning,
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
                ? normalizeDutyOverlaps(entry?.dutyOverlaps, meaning)
                : [];
            const officeDays = meaning === 'Office'
                ? normalizeOfficeDays(entry?.officeDays, meaning)
                : [];
            const outsideMorning = meaning === 'Office' ? Boolean(entry?.outsideMorning) : false;
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
                officeDays,
                outsideMorning,
            };
            cells.push(next);
            if (ON_DUTY_MEANINGS.includes(next.meaning)) {
                assignments.push({
                    date: cell.date,
                    code: next.code,
                    sod: next.sod,
                    dutyOverlaps: next.dutyOverlaps,
                    officeDays: next.officeDays,
                    outsideMorning: next.outsideMorning,
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
        legend: legend.map((e) => {
            const meaning = e.meaning;
            return {
                label: e.label,
                meaning,
                unit: e.unit || '',
                dutyOverlaps: ON_DUTY_MEANINGS.includes(meaning)
                    ? normalizeDutyOverlaps(e.dutyOverlaps, meaning)
                    : [],
                officeDays: meaning === 'Office' ? normalizeOfficeDays(e.officeDays, meaning) : [],
                outsideMorning: meaning === 'Office' ? Boolean(e.outsideMorning) : false,
            };
        }),
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
                    ? normalizeDutyOverlaps(e.dutyOverlaps, meaning)
                    : [],
                officeDays: meaning === 'Office' ? normalizeOfficeDays(e.officeDays, meaning) : [],
                outsideMorning: meaning === 'Office' ? Boolean(e.outsideMorning) : false,
            };
        }),
        inchargeStaffKey: setup.inchargeStaffKey || '',
        assistantStaffKey: setup.assistantStaffKey || '',
        units: setup.units || {},
        leaveByKey: setup.leaveByKey || {},
        confirmedAt: new Date().toISOString(),
    };
}
