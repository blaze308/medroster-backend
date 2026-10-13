/** Shared hospital document seed + unique join code allocation. */

import { db } from '../config/firebase.js';
import { generateHospitalCode, joinCodeKey, normalizeJoinCode } from './hospital-code.js';
import { getDefaultRuleModes } from './rule-modes.js';

export function defaultHospitalDoc({ hospitalName, hospitalType, hospitalRegion, hospitalLocation, now, joinCode }) {
    const code = joinCode || generateHospitalCode();
    return {
        name: hospitalName.trim(),
        type: hospitalType || 'District Hospital',
        region: hospitalRegion || 'Greater Accra',
        location: hospitalLocation?.trim() || '',
        ghsCode: '',
        joinCode: normalizeJoinCode(code),
        joinCodeKey: joinCodeKey(code),
        shiftTypes: [
            { id: 'morning', name: 'Morning', color: 'morning', startTime: '08:00', endTime: '14:00' },
            { id: 'afternoon', name: 'Afternoon', color: 'afternoon', startTime: '14:00', endTime: '20:00' },
            { id: 'night', name: 'Night', color: 'night', startTime: '20:00', endTime: '08:00' },
            { id: 'sod', name: 'SOD', color: 'sod', startTime: '08:00', endTime: '20:00' },
            { id: 'office', name: 'Office', color: 'office', startTime: '08:00', endTime: '14:00' },
        ],
        settings: {
            maxConsecutiveDays: 6,
            maxConsecutiveNights: 3,
            minSeniorStaffPerDay: 1,
            minSeniorStaffPerShift: 1,
            supervisoryCoverageSeverity: 'warning',
            maxHoursPerWeek: 48,
            ruleModes: getDefaultRuleModes(),
            validationRules: {
                enforceLeaveConflicts: true,
                enforceRoleShiftRestrictions: true,
                enforceSupervisoryCoverage: true,
                warnConsecutiveShifts: true,
            },
        },
        createdAt: now,
        updatedAt: now,
    };
}

/** Allocate a unique join code (retry on rare collision). */
export async function allocateUniqueJoinCode(preferred) {
    for (let attempt = 0; attempt < 8; attempt++) {
        const code = preferred && attempt === 0
            ? normalizeJoinCode(preferred)
            : generateHospitalCode();
        const key = joinCodeKey(code);
        const existing = await db.collection('hospitals').where('joinCodeKey', '==', key).limit(1).get();
        if (existing.empty) return { joinCode: normalizeJoinCode(code), joinCodeKey: key };
    }
    throw new Error('Could not allocate a unique hospital join code');
}

export async function findHospitalByJoinCode(code) {
    const key = joinCodeKey(code);
    if (!key || key.length < 6) return null;
    const snap = await db.collection('hospitals').where('joinCodeKey', '==', key).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { id: doc.id, ...doc.data() };
}
