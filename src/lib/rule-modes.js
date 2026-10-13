/** Flexible vs Hardened modes for on-ground Ghana guidelines. */

export const RULE_MODE_KEYS = [
    'seniorCoverage',
    'consecutiveNights',
    'consecutiveDays',
    'weeklyHours',
    'dailyRest',
    'weeklyRest',
    'offDayTarget',
];

export const RULE_MODE_DEFS = [
    {
        key: 'seniorCoverage',
        label: 'Senior / in-charge on Morning, Afternoon, Night',
        hint: 'Prefer at least one senior or in-charge on each coverage shift.',
    },
    {
        key: 'consecutiveNights',
        label: 'Max nights in a row',
        hint: 'Default cap is 3; wards often stretch this by agreement.',
    },
    {
        key: 'consecutiveDays',
        label: 'Max days in a row',
        hint: 'Default cap is 6 consecutive duty days.',
    },
    {
        key: 'weeklyHours',
        label: 'Weekly hours target',
        hint: 'Hospital target (default 48h); Labour Act guideline is ~40h.',
    },
    {
        key: 'dailyRest',
        label: 'Rest between shifts (≥12h)',
        hint: 'Labour Act §41 — aim for 12 hours between duties.',
    },
    {
        key: 'weeklyRest',
        label: 'Weekly contiguous rest (~48h)',
        hint: 'Labour Act §42 — aim for 48 hours off in a 7-day window.',
    },
    {
        key: 'offDayTarget',
        label: 'Off-day target for the cycle',
        hint: 'Regular staff ~12 offs / month plus marked holidays.',
    },
];

export function getDefaultRuleModes() {
    return Object.fromEntries(RULE_MODE_KEYS.map((k) => [k, 'flexible']));
}

export function normalizeRuleModes(raw) {
    const defaults = getDefaultRuleModes();
    if (!raw || typeof raw !== 'object') return defaults;
    const out = { ...defaults };
    for (const key of RULE_MODE_KEYS) {
        const v = raw[key];
        if (v === 'hard' || v === 'flexible') out[key] = v;
    }
    return out;
}

export function resolveRuleMode(settingsOrSchedule, key) {
    const modes = normalizeRuleModes(settingsOrSchedule?.ruleModes);
    return modes[key] === 'hard' ? 'hard' : 'flexible';
}

export function isRuleHard(settingsOrSchedule, key) {
    return resolveRuleMode(settingsOrSchedule, key) === 'hard';
}

export function severityForRule(settingsOrSchedule, key) {
    return isRuleHard(settingsOrSchedule, key) ? 'error' : 'warning';
}
