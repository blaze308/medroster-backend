/** Account tier limits and helpers. */

export const ACCOUNT_TYPES = {
    GUEST: 'guest',
    INDIVIDUAL: 'individual',
    ENTERPRISE: 'enterprise',
};

export const TIER_LIMITS = {
    guest: {
        maxStaff: 20,
        maxScheduleDays: 31,
        maxSchedules: 1,
        maxPdfExports: 5,
        allowAutoGenerate: true,
        allowDataExtraction: true,
        allowDepartments: false,
    },
    individual: {
        maxStaff: 50,
        maxScheduleDays: 31,
        maxSchedules: 12,
        maxPdfExports: Infinity,
        allowAutoGenerate: true,
        allowDataExtraction: true,
        allowDepartments: false,
    },
    enterprise: {
        maxStaff: Infinity,
        maxScheduleDays: 366,
        maxSchedules: Infinity,
        maxPdfExports: Infinity,
        allowAutoGenerate: true,
        allowDataExtraction: true,
        allowDepartments: true,
    },
};

export function getTierLimits(accountType) {
    return TIER_LIMITS[accountType] || TIER_LIMITS.individual;
}

export function scheduleDayCount(startDate, endDate) {
    const s = new Date(startDate);
    const e = new Date(endDate);
    s.setHours(0, 0, 0, 0);
    e.setHours(0, 0, 0, 0);
    return Math.round((e - s) / (24 * 60 * 60 * 1000)) + 1;
}
