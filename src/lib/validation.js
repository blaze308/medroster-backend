import { isStaffOnLeave, classifyStaffType, staffDisplayName, getStaffById } from './staff-utils.js';

function resolveStaffType(staff) {
    return staff?.staffType || classifyStaffType(staff?.rank);
}

function dateKey(date) {
    return new Date(date).toISOString().split('T')[0];
}

function shiftName(shiftType) {
    return shiftType?.name || '';
}

function isNightShift(shiftType) {
    return shiftName(shiftType) === 'Night';
}

function isWeekend(date) {
    const d = new Date(date).getDay();
    return d === 0 || d === 6;
}

function holidayKeys(schedule) {
    return new Set((schedule?.holidays || []).map((h) => dateKey(h.date || h)));
}

/** Hours covered by a shift, including overnight (end before start). */
export function shiftDurationHours(shiftType) {
    if (!shiftType?.startTime || !shiftType?.endTime) return 0;
    const [sh, sm = 0] = String(shiftType.startTime).split(':').map(Number);
    const [eh, em = 0] = String(shiftType.endTime).split(':').map(Number);
    if (Number.isNaN(sh) || Number.isNaN(eh)) return 0;
    let hours = (eh + em / 60) - (sh + sm / 60);
    if (hours <= 0) hours += 24;
    return hours;
}

function timeToMinutes(time) {
    const [h, m = 0] = String(time || '00:00').split(':').map(Number);
    return ((h || 0) * 60) + (m || 0);
}

/** True when two shifts share any open interval of time. Adjacent (end === start) does not overlap. */
export function shiftsOverlap(a, b) {
    if (!a?.startTime || !a?.endTime || !b?.startTime || !b?.endTime) return false;
    let aStart = timeToMinutes(a.startTime);
    let aEnd = timeToMinutes(a.endTime);
    let bStart = timeToMinutes(b.startTime);
    let bEnd = timeToMinutes(b.endTime);
    if (aEnd <= aStart) aEnd += 24 * 60;
    if (bEnd <= bStart) bEnd += 24 * 60;
    return aStart < bEnd && bStart < aEnd;
}

/** Monthly off-day target is 12. Scale it to the cycle length, then add holidays. */
export function scaledOffDayTarget(cycleDays, holidayCount = 0) {
    const monthlyOff = 12;
    const scaled = Math.round((monthlyOff * cycleDays) / 31);
    return Math.min(cycleDays, Math.max(0, scaled + holidayCount));
}

function weekStartContaining(date, scheduleStart) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const s = new Date(scheduleStart);
    s.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d - s) / (24 * 3600 * 1000));
    const week = Math.floor(Math.max(0, diffDays) / 7);
    const start = new Date(s);
    start.setDate(start.getDate() + week * 7);
    return start;
}

function earliestAssignmentDate(assignments) {
    let min = null;
    for (const a of assignments) {
        const d = new Date(a.date);
        if (Number.isNaN(d.getTime())) continue;
        d.setHours(0, 0, 0, 0);
        if (!min || d < min) min = d;
    }
    return min || new Date();
}

/** Hours this person already has in the 7-day window that contains `date`. */
export function hoursForStaffInWeekContaining({ assignments, staffId, date, scheduleStart }) {
    const target = String(staffId);
    const weekStart = weekStartContaining(date, scheduleStart);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    let total = 0;
    for (const a of assignments) {
        if (String(a.staffId) !== target) continue;
        const ad = new Date(a.date);
        ad.setHours(0, 0, 0, 0);
        if (ad >= weekStart && ad < weekEnd) total += shiftDurationHours(a.shiftType);
    }
    return total;
}

function isHoliday(date, schedule) {
    return holidayKeys(schedule).has(dateKey(date));
}

function formatShortDate(date) {
    return new Date(date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Senior rank, PNO, or ward supervisory roles — used for coverage guidelines. */
export function isSupervisoryCapable(staff) {
    if (!staff) return false;
    const type = resolveStaffType(staff);
    const role = staff.wardRole;
    return (
        type === 'senior' ||
        type === 'pno' ||
        role === 'incharge' ||
        role === 'assistant' ||
        role === 'shift_incharge'
    );
}

function minSeniorPerShift(settings) {
    const raw = settings?.minSeniorStaffPerShift ?? settings?.minSeniorStaffPerDay ?? 1;
    return Math.max(0, Number(raw) || 0);
}

/** Absolute start/end minutes from a fixed epoch day for an assignment. */
function assignmentBounds(assignment) {
    const day = new Date(assignment.date);
    day.setHours(0, 0, 0, 0);
    const dayMins = Math.floor(day.getTime() / 60000);
    const start = dayMins + timeToMinutes(assignment.shiftType?.startTime);
    let end = dayMins + timeToMinutes(assignment.shiftType?.endTime);
    if (end <= start) end += 24 * 60;
    return { start, end };
}

export function validateLeaveConflict(staff, date) {
    if (!staff) return { valid: false, error: 'Staff member not found' };
    if (isStaffOnLeave(staff, date)) {
        const dateStr = new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        return { valid: false, error: `${staffDisplayName(staff)} is on leave on ${dateStr}` };
    }
    return { valid: true };
}

export function validateRoleShiftCompatibility(staff, shiftType) {
    if (!staff || !shiftType) return { valid: true };
    if (
        isNightShift(shiftType) &&
        (staff.noNightShift || staff.maternityNoNight || staff.wardRole === 'incharge' || staff.wardRole === 'assistant')
    ) {
        if (staff.maternityNoNight) {
            return {
                valid: false,
                error: `${staffDisplayName(staff)} cannot work night duty (Labour Act §55: no night work 22:00–07:00 while protected)`,
            };
        }
        return { valid: false, error: `${staffDisplayName(staff)} cannot be assigned to night shifts` };
    }
    return { valid: true };
}

export function validateWorkRestriction(staff, date, shiftType, schedule) {
    if (!staff || !shiftType) return { valid: true };
    const name = shiftName(shiftType);
    const restriction = staff.workRestriction || 'none';

    if ((staff.wardRole === 'incharge' || staff.wardRole === 'assistant') && name !== 'Morning') {
        return { valid: false, error: `${staffDisplayName(staff)} is ${staff.wardRole} and should work morning shifts only` };
    }
    if ((staff.wardRole === 'incharge' || staff.wardRole === 'assistant') && isWeekend(date)) {
        return { valid: false, error: `${staffDisplayName(staff)} is ${staff.wardRole} and should not work weekends` };
    }
    if ((staff.wardRole === 'incharge' || staff.wardRole === 'assistant') && isHoliday(date, schedule)) {
        return { valid: false, error: `${staffDisplayName(staff)} is ${staff.wardRole} and should be off on marked holidays` };
    }
    if (restriction === 'onlyMorning' && name !== 'Morning') {
        return { valid: false, error: `${staffDisplayName(staff)} is restricted to morning shifts` };
    }
    if (restriction === 'onlyAfternoon' && name !== 'Afternoon') {
        return { valid: false, error: `${staffDisplayName(staff)} is restricted to afternoon shifts` };
    }
    if ((restriction === 'weekdayOnly' || restriction === 'studyLeave') && isWeekend(date)) {
        return { valid: false, error: `${staffDisplayName(staff)} should not work weekend shifts` };
    }
    return { valid: true };
}

/**
 * Ghana guideline: prefer ≥N senior / in-charge on Morning, Afternoon, Night.
 * Office clinic posts are morning-like but separate (no take-ups) unless outsideMorning.
 * Always soft — never blocks.
 * Returns { warnings: [{ shift, message, missingCount }] }.
 */
function isOfficeStyleAssignment(assignment) {
    const name = shiftName(assignment?.shiftType);
    if (name !== 'Office') return false;
    const outside = assignment?.outsideMorning || assignment?.shiftType?.outsideMorning;
    return !outside;
}

export function validateSupervisoryCoverage({ date, assignments, staffById, settings }) {
    const minSenior = minSeniorPerShift(settings);
    const warnings = [];
    if (minSenior <= 0) return { valid: true, warnings };

    const dateStr = dateKey(date);
    const dayAssignments = assignments.filter((a) => dateKey(a.date) === dateStr);

    const coverageShifts = ['Morning', 'Afternoon', 'Night'];
    for (const shift of coverageShifts) {
        const onShift = dayAssignments.filter((a) => {
            const name = shiftName(a.shiftType);
            if (isOfficeStyleAssignment(a)) return false;
            if (name === shift) return true;
            if ((shift === 'Morning' || shift === 'Afternoon') && name === 'SOD') return true;
            if (name === 'Office' && shift === 'Morning') return true;
            return false;
        });

        if (onShift.length === 0) continue;

        const seniorCount = onShift.filter((a) => isSupervisoryCapable(staffById.get(String(a.staffId)))).length;
        if (seniorCount < minSenior) {
            warnings.push({
                shift,
                message: `${formatShortDate(date)} ${shift} has no senior / in-charge (guideline)`,
                missingCount: minSenior - seniorCount,
            });
        }
    }

    return { valid: true, warnings };
}

export function validateMaxHoursPerWeek({ staffId, assignments, settings, schedule }) {
    const maxHours = settings?.maxHoursPerWeek ?? 48;
    const labourGuidelineHours = 40;
    const target = String(staffId);
    const own = assignments.filter((a) => String(a.staffId) === target);
    if (!own.length) return { valid: true };

    const scheduleStart = schedule?.startDate || earliestAssignmentDate(own);
    const byWeek = new Map();
    for (const a of own) {
        const key = weekStartContaining(a.date, scheduleStart).toISOString().split('T')[0];
        byWeek.set(key, (byWeek.get(key) || 0) + shiftDurationHours(a.shiftType));
    }
    let worst = 0;
    for (const hours of byWeek.values()) {
        if (hours > worst) worst = hours;
    }

    if (worst > maxHours) {
        return {
            valid: true,
            warning: `Total ${Math.round(worst)}h in a 7-day window (hospital target: ${maxHours}h; Labour Act guideline: ${labourGuidelineHours}h)`,
        };
    }
    if (worst > labourGuidelineHours) {
        return {
            valid: true,
            warning: `Total ${Math.round(worst)}h in a 7-day window — Labour Act guideline is ${labourGuidelineHours}h`,
        };
    }
    return { valid: true };
}

/** Labour Act §41: ≥12h continuous rest between consecutive working days/shifts. Soft only. */
export function validateDailyRest({ staffId, assignments }) {
    const target = String(staffId);
    const own = assignments
        .filter((a) => String(a.staffId) === target && a.shiftType?.startTime && a.shiftType?.endTime)
        .map((a) => ({ ...a, ...assignmentBounds(a) }))
        .sort((a, b) => a.start - b.start);

    if (own.length < 2) return { valid: true };

    const gaps = [];
    for (let i = 1; i < own.length; i++) {
        const gapHours = (own[i].start - own[i - 1].end) / 60;
        if (gapHours >= 0 && gapHours < 12) {
            gaps.push(gapHours);
        }
    }
    if (gaps.length === 0) return { valid: true };
    const worst = Math.min(...gaps);
    return {
        valid: true,
        warning: `Less than 12h rest between shifts (shortest gap ~${Math.round(worst * 10) / 10}h — Labour Act §41 guideline)`,
    };
}

/**
 * Labour Act §42: ~48h consecutive rest in every 7 normal working days.
 * Soft check over schedule weeks: longest contiguous off stretch < 48h while they worked that week.
 */
export function validateWeeklyRest({ staffId, assignments, schedule }) {
    const target = String(staffId);
    const own = assignments.filter((a) => String(a.staffId) === target);
    if (!own.length) return { valid: true };

    const scheduleStart = schedule?.startDate ? new Date(schedule.startDate) : earliestAssignmentDate(own);
    scheduleStart.setHours(0, 0, 0, 0);
    const scheduleEnd = schedule?.endDate ? new Date(schedule.endDate) : earliestAssignmentDate(own);
    scheduleEnd.setHours(0, 0, 0, 0);

    const worked = new Set(own.map((a) => dateKey(a.date)));
    let weekStart = new Date(scheduleStart);
    let flagged = false;

    while (weekStart <= scheduleEnd) {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);

        let workedInWeek = false;
        let longestOffHours = 0;
        let runOffHours = 0;

        for (let d = new Date(weekStart); d < weekEnd && d <= scheduleEnd; d.setDate(d.getDate() + 1)) {
            const key = dateKey(d);
            if (worked.has(key)) {
                workedInWeek = true;
                longestOffHours = Math.max(longestOffHours, runOffHours);
                runOffHours = 0;
            } else {
                runOffHours += 24;
            }
        }
        longestOffHours = Math.max(longestOffHours, runOffHours);

        // Also account for overnight: if last shift ends after midnight into an off day, rest already partially counted as calendar offs.
        if (workedInWeek && longestOffHours < 48) {
            flagged = true;
            break;
        }

        weekStart.setDate(weekStart.getDate() + 7);
    }

    if (!flagged) return { valid: true };
    return {
        valid: true,
        warning: 'No 48h contiguous rest in a 7-day window — Labour Act §42 guideline',
    };
}

export function validateConsecutiveShifts({ staffId, date, assignments, settings }) {
    const maxDays = settings?.maxConsecutiveDays ?? 6;
    const maxNights = settings?.maxConsecutiveNights ?? 3;
    const target = String(staffId);
    const own = assignments.filter((a) => String(a.staffId) === target).sort((a, b) => new Date(a.date) - new Date(b.date));
    const checkDate = new Date(date);
    checkDate.setHours(0, 0, 0, 0);

    let consecutive = 1;
    let cur = new Date(checkDate);
    cur.setDate(cur.getDate() - 1);
    while (consecutive < maxDays + 2) {
        const ds = dateKey(cur);
        if (!own.some((a) => dateKey(a.date) === ds)) break;
        consecutive++;
        cur.setDate(cur.getDate() - 1);
    }
    if (consecutive > maxDays) return { valid: true, warning: `${consecutive} consecutive days of work` };

    const today = own.find((a) => dateKey(a.date) === dateKey(checkDate));
    if (today?.shiftType?.name === 'Night') {
        let nights = 1;
        let nd = new Date(checkDate);
        nd.setDate(nd.getDate() - 1);
        while (nights < maxNights + 2) {
            const ds = dateKey(nd);
            if (!own.find((a) => dateKey(a.date) === ds && a.shiftType?.name === 'Night')) break;
            nights++;
            nd.setDate(nd.getDate() - 1);
        }
        if (nights > maxNights) return { valid: true, warning: `${nights} consecutive night shifts; fourth nights should only be used with caution` };
    }
    return { valid: true };
}

export function validateAssignment({ staff, date, shiftType, context }) {
    const errors = [];
    const warnings = [];
    if (!staff) return { valid: false, errors: ['Staff member not found'], warnings: [] };
    if (!shiftType) return { valid: false, errors: ['Shift type not found'], warnings: [] };

    const settings = context?.settings || {};
    const rules = settings.validationRules || {};
    const assignments = context?.assignments || [];
    const schedule = context?.schedule;

    const leave = validateLeaveConflict(staff, date);
    if (!leave.valid) errors.push(leave.error);
    const role = validateRoleShiftCompatibility(staff, shiftType);
    if (!role.valid) errors.push(role.error);
    const restriction = validateWorkRestriction(staff, date, shiftType, schedule);
    if (!restriction.valid) errors.push(restriction.error);

    if (rules.warnConsecutiveShifts !== false) {
        const r = validateConsecutiveShifts({ staffId: staff._id || staff.id, date, assignments, settings });
        if (r.warning) warnings.push(r.warning);
    }
    const provisional = [...assignments, { staffId: staff._id || staff.id, date, shiftType }];
    const hoursCheck = validateMaxHoursPerWeek({
        staffId: staff._id || staff.id,
        assignments: provisional,
        settings,
        schedule,
    });
    if (hoursCheck.warning) warnings.push(hoursCheck.warning);

    const dailyRest = validateDailyRest({ staffId: staff._id || staff.id, assignments: provisional });
    if (dailyRest.warning) warnings.push(dailyRest.warning);

    return { valid: errors.length === 0, errors, warnings };
}

export function validateFullSchedule({ staff, assignments, settings, schedule }) {
    const errors = [];
    const warnings = [];
    const dateViolations = {};
    const staffById = new Map((staff || []).map((s) => [String(s._id || s.id), s]));
    const dates = [...new Set((assignments || []).map((a) => dateKey(a.date)))];

    dates.forEach((dateStr) => {
        const date = new Date(dateStr);
        const coverage = validateSupervisoryCoverage({ date, assignments, staffById, settings });
        for (const w of coverage.warnings || []) {
            warnings.push({
                type: 'supervisory_coverage',
                date: dateStr,
                shift: w.shift,
                message: w.message,
                severity: 'warning',
            });
            if (!dateViolations[dateStr]) dateViolations[dateStr] = [];
            if (!dateViolations[dateStr].includes('missing_supervisor')) {
                dateViolations[dateStr].push('missing_supervisor');
            }
        }

        const dayAssignments = assignments.filter((a) => dateKey(a.date) === dateStr);
        dayAssignments.forEach((a) => {
            const sm = staffById.get(String(a.staffId));
            if (!sm) return;
            if (isStaffOnLeave(sm, date)) {
                errors.push({ type: 'leave_conflict', date: dateStr, staffId: String(sm._id || sm.id), staffName: staffDisplayName(sm), message: `${staffDisplayName(sm)} is on leave`, severity: 'error' });
            }
            if (a.shiftType) {
                const role = validateRoleShiftCompatibility(sm, a.shiftType);
                if (!role.valid) errors.push({ type: 'role_shift_incompatible', date: dateStr, staffId: String(sm._id || sm.id), staffName: staffDisplayName(sm), message: role.error, severity: 'error' });
                const restriction = validateWorkRestriction(sm, date, a.shiftType, schedule);
                if (!restriction.valid) errors.push({ type: 'work_restriction', date: dateStr, staffId: String(sm._id || sm.id), staffName: staffDisplayName(sm), message: restriction.error, severity: 'error' });
            }
        });
    });

    (staff || []).forEach((sm) => {
        const id = String(sm._id || sm.id);
        const own = assignments.filter((a) => String(a.staffId) === id);
        if (!own.length) return;

        const r = validateMaxHoursPerWeek({ staffId: id, assignments, settings, schedule });
        if (r.warning) warnings.push({ type: 'max_hours', staffId: id, staffName: staffDisplayName(sm), message: r.warning, severity: 'warning' });

        const dailyRest = validateDailyRest({ staffId: id, assignments: own });
        if (dailyRest.warning) {
            warnings.push({ type: 'daily_rest', staffId: id, staffName: staffDisplayName(sm), message: dailyRest.warning, severity: 'warning' });
        }

        const weeklyRest = validateWeeklyRest({ staffId: id, assignments: own, schedule });
        if (weeklyRest.warning) {
            warnings.push({ type: 'weekly_rest', staffId: id, staffName: staffDisplayName(sm), message: weeklyRest.warning, severity: 'warning' });
        }

        if (schedule?.startDate && schedule?.endDate && sm.wardRole === 'regular') {
            const start = new Date(schedule.startDate);
            const end = new Date(schedule.endDate);
            const totalDays = Math.floor((end - start) / (24 * 3600 * 1000)) + 1;
            const targetOffDays = scaledOffDayTarget(totalDays, holidayKeys(schedule).size);
            const workedDays = new Set(own.map((a) => dateKey(a.date))).size;
            const offDays = totalDays - workedDays;
            if (offDays < targetOffDays) {
                warnings.push({ type: 'off_day_target', staffId: id, staffName: staffDisplayName(sm), message: `${offDays} off days in this cycle (target: ${targetOffDays})`, severity: 'warning' });
            }
        }
    });

    const coverageWarnings = warnings.filter((e) => e.type === 'supervisory_coverage');

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        dateViolations,
        summary: {
            totalErrors: errors.length,
            totalWarnings: warnings.length,
            leaveConflicts: errors.filter((e) => e.type === 'leave_conflict').length,
            roleViolations: errors.filter((e) => e.type === 'role_shift_incompatible').length,
            coverageIssues: coverageWarnings.length,
            restrictionViolations: errors.filter((e) => e.type === 'work_restriction').length,
        },
    };
}

export { getStaffById };
