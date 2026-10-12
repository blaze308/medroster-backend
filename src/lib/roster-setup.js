/** Build ward roster setup proposals + remap without calling OpenAI. */

export const LEGEND_MEANINGS = [
    'Morning',
    'Afternoon',
    'Night',
    'SOD',
    'Off',
    'Holiday',
    'Leave',
];

const KNOWN_LABEL_MEANING = {
    M: 'Morning',
    A: 'Afternoon',
    N: 'Night',
    O: 'Off',
    H: 'Holiday',
    L: 'Leave',
    LV: 'Leave',
    SOD: 'SOD',
    XM: 'Morning',
    XA: 'Afternoon',
    XN: 'Night',
    PM: 'Morning',
    PA: 'Afternoon',
    PN: 'Night',
    OFF: 'Off',
    P: '', // often Polyclinic unit — needs confirm
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
            const unit = saved?.unit || fromFile?.unit || unitFromLabel(label) || '';
            const confidence = confidenceFor(label, meaning, Boolean(saved));
            const needsConfirm = confidence !== 'high' || !meaning;
            return {
                label,
                count,
                meaning: meaning || '',
                unit,
                confidence,
                needsConfirm,
                fromSaved: Boolean(saved),
            };
        });

    const legendDraft = codes.map((c) => ({
        label: c.label,
        meaning: c.meaning,
        unit: c.unit,
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
            const code = onLeave && !meaning ? 'LV' : codeLetter(meaning) || (meaning ? '' : (cell.code || ''));
            const sod = meaning === 'SOD' || Boolean(cell.sod);
            const next = {
                date: cell.date,
                text: cell.text,
                code: onLeave && (!meaning || meaning === 'Leave') ? 'LV' : code,
                sod,
                unit,
                meaning: onLeave && (!meaning || meaning === 'Leave') ? 'Leave' : meaning,
            };
            cells.push(next);
            if (['Morning', 'Afternoon', 'Night', 'SOD'].includes(next.meaning)) {
                assignments.push({
                    date: cell.date,
                    code: next.code,
                    sod: next.sod,
                });
            }
        }

        return {
            ...s,
            key,
            wardRole,
            leaveType,
            leaveNote: leaveType ? `${leaveType} leave` : (s.leaveNote || ''),
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
        })),
        setupApplied: true,
    };
}

export function buildRosterSetupPayload(setup) {
    return {
        legend: (setup.legend || []).map((e) => ({
            label: String(e.label || '').trim(),
            meaning: String(e.meaning || '').trim(),
            unit: String(e.unit || '').trim(),
        })),
        inchargeStaffKey: setup.inchargeStaffKey || '',
        assistantStaffKey: setup.assistantStaffKey || '',
        units: setup.units || {},
        leaveByKey: setup.leaveByKey || {},
        confirmedAt: new Date().toISOString(),
    };
}
