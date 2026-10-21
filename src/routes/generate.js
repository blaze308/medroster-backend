import { Router } from 'express';
import { db, batchedDelete, batchedSet } from '../config/firebase.js';
import { requireAuth, requireHospital, requireWriteAccess } from '../middleware/auth.js';
import { isStaffOnLeave, classifyStaffType } from '../lib/staff-utils.js';
import {
    hoursForStaffInWeekContaining,
    scaledOffDayTarget,
    shiftDurationHours,
    shiftsOverlap,
} from '../lib/validation.js';
import { isRuleHard, normalizeRuleModes } from '../lib/rule-modes.js';
import { normalizeCoverTargets, DEFAULT_COVER_TARGETS } from '../lib/roster-setup.js';
import { logAutoGeneration, logError } from '../lib/logger.js';

const router = Router({ mergeParams: true });

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const COVER_SHIFT_NAMES = ['Morning', 'Afternoon', 'Night'];

function dateKey(date) {
    return new Date(date).toISOString().split('T')[0];
}

function isWeekend(date) {
    const d = new Date(date).getDay();
    return d === 0 || d === 6;
}

function buildCycleDays(schedule) {
    const days = [];
    const cur = new Date(schedule.startDate);
    const end = new Date(schedule.endDate);
    cur.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    while (cur <= end) {
        days.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return days;
}

function holidaySet(schedule) {
    return new Set((schedule.holidays || []).map((h) => dateKey(h.date || h)));
}

function canWorkShift(staff, day, shift, holidays) {
    const shiftName = shift.name;
    const restriction = staff.workRestriction || 'none';
    const wardRole = staff.wardRole || 'regular';
    const holiday = holidays.has(dateKey(day));

    if (isStaffOnLeave(staff, day)) return false;

    if (wardRole === 'incharge' || wardRole === 'assistant') {
        if (shiftName !== 'Morning') return false;
        if (isWeekend(day) || holiday) return false;
    }

    if (shiftName === 'Night' && (staff.noNightShift || staff.maternityNoNight || wardRole === 'incharge' || wardRole === 'assistant')) {
        return false;
    }

    if (restriction === 'onlyMorning' && shiftName !== 'Morning') return false;
    if (restriction === 'onlyAfternoon' && shiftName !== 'Afternoon') return false;
    if ((restriction === 'weekdayOnly' || restriction === 'studyLeave') && isWeekend(day)) return false;

    return true;
}

function preferenceScore(staff, day, shift, usePreferences) {
    if (!usePreferences) return 0;
    let score = 0;
    const dayName = DAY_NAMES[new Date(day).getDay()];
    if ((staff.preferredOffDays || []).includes(dayName)) score += 2;
    if ((staff.preferredShifts || []).length > 0 && !(staff.preferredShifts || []).includes(shift.name)) score += 1;
    return score;
}

// POST /hospitals/:id/schedules/:schedId/generate
router.post('/', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    const t0 = Date.now();
    try {
        const { id: hospitalId, schedId } = req.params;
        const usePreferences = Boolean(req.body?.usePreferences);

        const [hospitalSnap, schedSnap] = await Promise.all([
            db.doc(`hospitals/${hospitalId}`).get(),
            db.doc(`hospitals/${hospitalId}/schedules/${schedId}`).get(),
        ]);
        if (!hospitalSnap.exists || !schedSnap.exists) {
            return res.status(404).json({ error: 'Schedule not found' });
        }
        const hospitalData = hospitalSnap.data();
        const schedule = { _id: schedSnap.id, ...schedSnap.data() };

        let wardGuidelines = {};
        let coverTargets = DEFAULT_COVER_TARGETS;
        if (schedule.wardId) {
            const wardSnap = await db.doc(`hospitals/${hospitalId}/wards/${schedule.wardId}`).get();
            if (wardSnap.exists) {
                const wardData = wardSnap.data() || {};
                wardGuidelines = wardData.guidelines || {};
                coverTargets = normalizeCoverTargets(wardData.rosterSetup?.coverTargets);
            }
        }

        const staffSnap = await db.collection(`hospitals/${hospitalId}/staff`)
            .where('wardId', '==', schedule.wardId)
            .where('employmentStatus', 'in', ['Active', 'Probation'])
            .get();

        const allStaff = staffSnap.docs.map((s) => ({ _id: s.id, ...s.data() }));
        if (allStaff.length === 0) {
            return res.status(400).json({ error: 'No staff available to schedule' });
        }

        const existingSnap = await db.collection(`hospitals/${hospitalId}/schedules/${schedId}/assignments`).get();
        const existingRefs = existingSnap.docs.map((d) => d.ref);

        const shiftTypes = hospitalData.shiftTypes || [];
        const baseSettings = hospitalData.settings || {};
        const settings = {
            ...baseSettings,
            ruleModes: normalizeRuleModes(baseSettings.ruleModes),
            minSeniorStaffPerShift:
                wardGuidelines.minSeniorPerShift ??
                baseSettings.minSeniorStaffPerShift ??
                baseSettings.minSeniorStaffPerDay ??
                1,
        };
        const minSenior = Math.max(0, settings.minSeniorStaffPerShift ?? 1);
        const maxConsecutive = settings.maxConsecutiveDays ?? 6;
        const maxNights = settings.maxConsecutiveNights ?? 3;
        const maxHoursPerWeek = settings.maxHoursPerWeek ?? 48;
        const hardenDays = isRuleHard(settings, 'consecutiveDays');
        const hardenNights = isRuleHard(settings, 'consecutiveNights');
        const hardenHours = isRuleHard(settings, 'weeklyHours');
        const hardenOffDays = isRuleHard(settings, 'offDayTarget');
        const hardenSenior = isRuleHard(settings, 'seniorCoverage');

        const days = buildCycleDays(schedule);
        const holidays = holidaySet(schedule);
        const holidayCount = holidays.size;
        const scheduleStart = days[0] || new Date(schedule.startDate);

        const maxWorkDaysByStaff = new Map(
            allStaff.map((s) => {
                if ((s.wardRole || 'regular') !== 'regular') return [s._id, days.length];
                return [s._id, Math.max(0, days.length - scaledOffDayTarget(days.length, holidayCount))];
            })
        );

        const assignmentCounts = new Map(allStaff.map((s) => [s._id, 0]));
        const consecutiveTracker = new Map(allStaff.map((s) => [s._id, 0]));
        const consecutiveNightTracker = new Map(allStaff.map((s) => [s._id, 0]));
        const lastWorkedDate = new Map();
        const created = [];
        const warnings = [];

        const seniorIds = new Set(
            allStaff
                .filter((s) => {
                    const t = s.staffType || classifyStaffType(s.rank);
                    const role = s.wardRole;
                    return (
                        t === 'senior' ||
                        t === 'pno' ||
                        role === 'incharge' ||
                        role === 'assistant' ||
                        role === 'shift_incharge'
                    );
                })
                .map((s) => s._id)
        );

        const needsSeniorCoverage = (name) =>
            name === 'Morning' || name === 'Afternoon' || name === 'Night';

        for (const day of days) {
            for (const [sid, last] of lastWorkedDate.entries()) {
                const diff = (day - last) / (24 * 3600 * 1000);
                if (diff > 1) {
                    consecutiveTracker.set(sid, 0);
                    consecutiveNightTracker.set(sid, 0);
                }
            }

            const assignedToday = new Set();
            const seniorsByShift = new Map();
            const filledShiftsToday = [];
            const orderedShifts = [...shiftTypes].sort((a, b) => {
                if (a.name === 'Morning' && b.name !== 'Morning') return -1;
                if (b.name === 'Morning' && a.name !== 'Morning') return 1;
                return 0;
            });

            for (const shift of orderedShifts) {
                if (filledShiftsToday.some((filled) => shiftsOverlap(filled, shift))) continue;

                const isCover = COVER_SHIFT_NAMES.includes(shift.name);
                // Use local weekend check (same as canWorkShift) so targets match Ghana calendar days
                const seatsNeeded = isCover
                    ? (isWeekend(day)
                        ? (coverTargets[shift.name]?.weekend || 1)
                        : (coverTargets[shift.name]?.weekday || 1))
                    : 1;
                const isNight = shift.name === 'Night';
                const shiftHours = shiftDurationHours(shift);
                let seatsFilled = 0;

                for (let seat = 0; seat < seatsNeeded; seat++) {
                    const pool = allStaff.filter((s) => {
                        const sid = s._id;
                        if (assignedToday.has(sid)) return false;
                        if (!canWorkShift(s, day, shift, holidays)) return false;
                        if (hardenDays && (consecutiveTracker.get(sid) || 0) >= maxConsecutive) return false;
                        if (hardenOffDays && (assignmentCounts.get(sid) || 0) >= (maxWorkDaysByStaff.get(sid) ?? days.length)) {
                            return false;
                        }
                        if (hardenNights && isNight && (consecutiveNightTracker.get(sid) || 0) >= maxNights) return false;
                        if (hardenHours) {
                            const weekHours = hoursForStaffInWeekContaining({
                                assignments: created,
                                staffId: sid,
                                date: day,
                                scheduleStart,
                            });
                            if (weekHours + shiftHours > maxHoursPerWeek) return false;
                        }
                        return true;
                    });

                    if (pool.length === 0) break;

                    pool.sort((a, b) => {
                        const roleA = a.wardRole === 'incharge' || a.wardRole === 'assistant' ? -1 : 0;
                        const roleB = b.wardRole === 'incharge' || b.wardRole === 'assistant' ? -1 : 0;
                        const softConsec =
                            !hardenDays
                                ? (consecutiveTracker.get(a._id) || 0) - (consecutiveTracker.get(b._id) || 0)
                                : 0;
                        return (
                            roleA - roleB ||
                            softConsec ||
                            preferenceScore(a, day, shift, usePreferences) - preferenceScore(b, day, shift, usePreferences) ||
                            (assignmentCounts.get(a._id) || 0) - (assignmentCounts.get(b._id) || 0)
                        );
                    });

                    let pick = pool[0];
                    // Prefer a senior/in-charge for the first seat(s) on each cover shift
                    if (needsSeniorCoverage(shift.name) && minSenior > 0) {
                        const have = seniorsByShift.get(shift.name)?.size || 0;
                        if (have < minSenior) {
                            const seniorPick = pool.find((s) => seniorIds.has(s._id));
                            if (seniorPick) pick = seniorPick;
                            else if (hardenSenior) {
                                // No eligible senior in pool — still assign (shortage); validation will error.
                            }
                        }
                    }

                    const sid = pick._id;
                    created.push({
                        scheduleId: schedId,
                        hospitalId,
                        staffId: sid,
                        departmentId: pick.departmentId,
                        wardId: schedule.wardId,
                        date: day.toISOString(),
                        shiftType: { name: shift.name, color: shift.color, startTime: shift.startTime, endTime: shift.endTime },
                        createdAt: new Date().toISOString(),
                    });

                    assignmentCounts.set(sid, (assignmentCounts.get(sid) || 0) + 1);
                    consecutiveTracker.set(sid, (consecutiveTracker.get(sid) || 0) + 1);
                    if (isNight) {
                        consecutiveNightTracker.set(sid, (consecutiveNightTracker.get(sid) || 0) + 1);
                    } else {
                        consecutiveNightTracker.set(sid, 0);
                    }
                    lastWorkedDate.set(sid, day);
                    assignedToday.add(sid);
                    seatsFilled += 1;
                    if (seniorIds.has(sid) && needsSeniorCoverage(shift.name)) {
                        if (!seniorsByShift.has(shift.name)) seniorsByShift.set(shift.name, new Set());
                        seniorsByShift.get(shift.name).add(sid);
                    }
                }

                if (seatsFilled > 0) filledShiftsToday.push(shift);
            }
        }

        if (created.length === 0) {
            return res.status(400).json({ error: 'Could not generate any assignments', warnings });
        }

        const assignColl = db.collection(`hospitals/${hospitalId}/schedules/${schedId}/assignments`);
        await batchedSet(assignColl, created);
        if (existingRefs.length > 0) {
            await batchedDelete(existingRefs);
        }

        logAutoGeneration(schedId, allStaff.length, created.length, Date.now() - t0);

        return res.json({
            success: true,
            assignmentsCreated: created.length,
            staffConsidered: allStaff.length,
            warnings,
        });
    } catch (err) {
        logError('GENERATE_API', 'Failed to auto-generate schedule', err);
        return res.status(500).json({ error: err.message });
    }
});

export default router;
