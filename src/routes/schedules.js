import { Router } from 'express';
import { db, batchedDelete } from '../config/firebase.js';
import { requireAuth, requireHospital, requireWriteAccess } from '../middleware/auth.js';
import { compareStaffName } from '../lib/staff-utils.js';
import { validateAssignment } from '../lib/validation.js';
import { logDataModification, logValidationFailure, logError } from '../lib/logger.js';

const router = Router({ mergeParams: true });

function normalizeCycle(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    if (end < start) return null;
    const days = Math.floor((end - start) / (24 * 3600 * 1000)) + 1;
    if (days < 1 || days > 31) return null;
    return { start, end, days };
}

function normalizeHolidays(holidays, start, end) {
    if (!Array.isArray(holidays)) return [];
    const seen = new Set();
    return holidays.map((h) => {
        const date = new Date(typeof h === 'string' ? h : h.date);
        if (isNaN(date.getTime())) return null;
        date.setHours(0, 0, 0, 0);
        if (date < start || date > end) return null;
        const key = date.toISOString().split('T')[0];
        if (seen.has(key)) return null;
        seen.add(key);
        return { date: date.toISOString(), name: typeof h === 'object' ? String(h.name || '').trim() : '' };
    }).filter(Boolean);
}

// GET /hospitals/:id/schedules
router.get('/', requireAuth, requireHospital, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;

        const [schedSnap, wardSnap] = await Promise.all([
            db.collection(`hospitals/${hospitalId}/schedules`).orderBy('startDate', 'desc').get(),
            db.collection(`hospitals/${hospitalId}/wards`).get(),
        ]);
        const firstWard = wardSnap.docs[0];

        const schedules = await Promise.all(schedSnap.docs.map(async (s) => {
            const data = s.data();
            const countResult = await s.ref.collection('assignments').count().get();
            return {
                _id: s.id,
                ...data,
                departmentId: data.departmentId || (firstWard ? firstWard.data().departmentId : ''),
                wardId: data.wardId || (firstWard ? firstWard.id : ''),
                assignmentCount: countResult.data().count,
            };
        }));

        return res.json(schedules);
    } catch (err) {
        logError('SCHEDULES_API', 'Failed to list schedules', err);
        return res.status(500).json({ error: err.message });
    }
});

// GET /hospitals/:id/schedules/:schedId — full schedule payload for calendar view
router.get('/:schedId', requireAuth, requireHospital, async (req, res) => {
    try {
        const { id: hospitalId, schedId } = req.params;

        const schedSnap = await db.doc(`hospitals/${hospitalId}/schedules/${schedId}`).get();
        if (!schedSnap.exists) return res.status(404).json({ error: 'Schedule not found' });
        const schedule = { _id: schedSnap.id, ...schedSnap.data() };

        const [hospitalSnap, deptSnap, wardSnap] = await Promise.all([
            db.doc(`hospitals/${hospitalId}`).get(),
            db.collection(`hospitals/${hospitalId}/departments`).orderBy('name').get(),
            db.collection(`hospitals/${hospitalId}/wards`).orderBy('name').get(),
        ]);
        if (!hospitalSnap.exists) return res.status(404).json({ error: 'Hospital not found' });

        const wards = wardSnap.docs.map((w) => ({ _id: w.id, ...w.data() }));
        const fallbackWard = schedule.wardId ? null : wards[0];
        const scheduleWardId = schedule.wardId || fallbackWard?._id;
        const scheduleDepartmentId = schedule.departmentId || fallbackWard?.departmentId;

        let staffQuery = db.collection(`hospitals/${hospitalId}/staff`);
        if (scheduleWardId) staffQuery = staffQuery.where('wardId', '==', scheduleWardId);
        else if (scheduleDepartmentId) staffQuery = staffQuery.where('departmentId', '==', scheduleDepartmentId);

        const [staffSnap, assignSnap] = await Promise.all([
            staffQuery.get(),
            db.collection(`hospitals/${hospitalId}/schedules/${schedId}/assignments`).get(),
        ]);

        const hospitalData = { _id: hospitalSnap.id, ...hospitalSnap.data() };
        const staff = staffSnap.docs.map((s) => {
            const data = s.data();
            return {
                _id: s.id,
                ...data,
                wardId: data.wardId || scheduleWardId || '',
                fullName: `${data.firstName || ''} ${data.lastName || ''}`.trim(),
            };
        }).sort(compareStaffName);
        const assignments = assignSnap.docs.map((a) => ({ _id: a.id, ...a.data() }));

        return res.json({
            schedule: {
                ...schedule,
                departmentId: scheduleDepartmentId || '',
                wardId: scheduleWardId || '',
            },
            hospital: hospitalData,
            departments: deptSnap.docs.map((d) => ({ _id: d.id, ...d.data() })),
            wards,
            staff,
            assignments,
        });
    } catch (err) {
        logError('SCHEDULES_API', 'Failed to fetch schedule', err);
        return res.status(500).json({ error: err.message });
    }
});

// POST /hospitals/:id/schedules
router.post('/', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;
        const hospitalSnap = await db.doc(`hospitals/${hospitalId}`).get();
        if (!hospitalSnap.exists) return res.status(404).json({ error: 'Hospital not found' });

        const wardSnap = await db.doc(`hospitals/${hospitalId}/wards/${req.body.wardId}`).get();
        if (!wardSnap.exists) return res.status(400).json({ error: 'Ward is required' });
        const ward = wardSnap.data();

        const cycle = normalizeCycle(req.body.startDate, req.body.endDate);
        if (!cycle) return res.status(400).json({ error: 'Invalid cycle dates. Choose a start/end range up to 31 days.' });

        // Check for duplicate
        const dupSnap = await db.collection(`hospitals/${hospitalId}/schedules`)
            .where('wardId', '==', req.body.wardId)
            .where('startDate', '==', cycle.start.toISOString())
            .where('endDate', '==', cycle.end.toISOString())
            .get();
        if (!dupSnap.empty) {
            return res.status(409).json({
                error: 'A schedule for this ward and date range already exists',
                scheduleId: dupSnap.docs[0].id,
            });
        }

        const now = new Date().toISOString();
        const data = {
            hospitalId,
            departmentId: ward.departmentId,
            wardId: req.body.wardId,
            name: req.body.name?.trim() || '',
            startDate: cycle.start.toISOString(),
            endDate: cycle.end.toISOString(),
            holidays: normalizeHolidays(req.body.holidays, cycle.start, cycle.end),
            status: 'draft',
            publishedAt: null,
            createdAt: now,
            updatedAt: now,
        };

        const ref = db.collection(`hospitals/${hospitalId}/schedules`).doc();
        await ref.set(data);

        logDataModification('CREATE', 'schedule', ref.id, { hospitalId, wardId: req.body.wardId, startDate: cycle.start.toISOString() });
        return res.status(201).json({ _id: ref.id, ...data });
    } catch (err) {
        logError('SCHEDULES_API', 'Failed to create schedule', err);
        return res.status(500).json({ error: err.message });
    }
});

// PATCH /hospitals/:id/schedules/:schedId
router.patch('/:schedId', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId, schedId } = req.params;
        const ref = db.doc(`hospitals/${hospitalId}/schedules/${schedId}`);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Schedule not found' });

        const allowed = ['name', 'status', 'publishedAt', 'holidays'];
        const update = { updatedAt: new Date().toISOString() };
        for (const k of allowed) {
            if (req.body[k] !== undefined) update[k] = req.body[k];
        }
        if (update.status === 'published' && !update.publishedAt) {
            update.publishedAt = new Date().toISOString();
        }

        await ref.update(update);
        const updated = await ref.get();

        logDataModification('UPDATE', 'schedule', schedId, { fields: Object.keys(update) });
        return res.json({ _id: updated.id, ...updated.data() });
    } catch (err) {
        logError('SCHEDULES_API', 'Failed to update schedule', err);
        return res.status(500).json({ error: err.message });
    }
});

// DELETE /hospitals/:id/schedules/:schedId
router.delete('/:schedId', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId, schedId } = req.params;
        const ref = db.doc(`hospitals/${hospitalId}/schedules/${schedId}`);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Schedule not found' });

        const assignSnap = await ref.collection('assignments').get();
        await batchedDelete(assignSnap.docs.map((d) => d.ref));
        await ref.delete();

        logDataModification('DELETE', 'schedule', schedId, { removedAssignments: assignSnap.size });
        return res.json({ success: true });
    } catch (err) {
        logError('SCHEDULES_API', 'Failed to delete schedule', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── Assignments sub-resource ─────────────────────────────────────────────────

// POST /hospitals/:id/schedules/:schedId/assignments
router.post('/:schedId/assignments', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId, schedId } = req.params;
        const { staffId, date, shiftTypeId } = req.body;

        if (!staffId || !date) return res.status(400).json({ error: 'staffId and date are required' });

        const [hospitalSnap, schedSnap, staffSnap] = await Promise.all([
            db.doc(`hospitals/${hospitalId}`).get(),
            db.doc(`hospitals/${hospitalId}/schedules/${schedId}`).get(),
            db.doc(`hospitals/${hospitalId}/staff/${staffId}`).get(),
        ]);

        if (!schedSnap.exists) return res.status(404).json({ error: 'Schedule not found' });
        if (!staffSnap.exists) return res.status(404).json({ error: 'Staff not found' });
        const schedule = { _id: schedSnap.id, ...schedSnap.data() };
        const staff = { _id: staffSnap.id, ...staffSnap.data() };

        if (staff.wardId !== schedule.wardId) {
            return res.status(400).json({ error: 'Staff member does not belong to this schedule ward' });
        }

        const dateObj = new Date(date);
        dateObj.setHours(0, 0, 0, 0);
        const cycleStart = new Date(schedule.startDate);
        const cycleEnd = new Date(schedule.endDate);
        cycleStart.setHours(0, 0, 0, 0);
        cycleEnd.setHours(23, 59, 59, 999);
        if (dateObj < cycleStart || dateObj > cycleEnd) {
            return res.status(400).json({ error: 'Date is outside this schedule cycle' });
        }

        const assignColl = db.collection(`hospitals/${hospitalId}/schedules/${schedId}/assignments`);

        // null shiftTypeId = clear the cell
        if (!shiftTypeId) {
            const existSnap = await assignColl
                .where('staffId', '==', staffId)
                .where('date', '==', dateObj.toISOString())
                .get();
            if (!existSnap.empty) {
                await existSnap.docs[0].ref.delete();
                logDataModification('DELETE', 'assignment', existSnap.docs[0].id, { staffId, date: dateObj.toISOString() });
            }
            return res.json({ success: true, removed: !existSnap.empty });
        }

        const hospitalData = hospitalSnap.data();
        const shiftType = (hospitalData.shiftTypes || []).find((st) => st.id === shiftTypeId || st.name === shiftTypeId);
        if (!shiftType) return res.status(404).json({ error: 'Shift type not found' });

        // Validate
        const allAssignSnap = await assignColl.where('wardId', '==', schedule.wardId).get();
        const allAssignments = allAssignSnap.docs.map((d) => ({ _id: d.id, ...d.data() }));

        const result = validateAssignment({
            staff,
            date: dateObj,
            shiftType,
            context: { assignments: allAssignments, settings: hospitalData.settings, schedule },
        });

        if (!result.valid) {
            logValidationFailure(schedId, result.errors);
            return res.status(400).json({ error: 'Validation failed', errors: result.errors, warnings: result.warnings });
        }

        const shiftSnap = { name: shiftType.name, color: shiftType.color, startTime: shiftType.startTime, endTime: shiftType.endTime };
        const assignData = {
            scheduleId: schedId,
            hospitalId,
            staffId,
            departmentId: staff.departmentId,
            wardId: staff.wardId,
            date: dateObj.toISOString(),
            shiftType: shiftSnap,
            createdAt: new Date().toISOString(),
        };

        // Upsert: one assignment per (schedule, staff, date)
        const existSnap = await assignColl
            .where('staffId', '==', staffId)
            .where('date', '==', dateObj.toISOString())
            .get();

        let assignRef;
        if (!existSnap.empty) {
            assignRef = existSnap.docs[0].ref;
            await assignRef.update(assignData);
        } else {
            assignRef = assignColl.doc();
            await assignRef.set(assignData);
        }

        logDataModification('UPSERT', 'assignment', assignRef.id, { staffId, date: dateObj.toISOString(), shift: shiftSnap.name });
        return res.json({ assignment: { _id: assignRef.id, ...assignData }, warnings: result.warnings });
    } catch (err) {
        logError('ASSIGNMENTS_API', 'Failed to create assignment', err);
        return res.status(500).json({ error: err.message });
    }
});

// DELETE /hospitals/:id/schedules/:schedId/assignments?clearAll=true|staffId=...&date=...
router.delete('/:schedId/assignments', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId, schedId } = req.params;
        const assignColl = db.collection(`hospitals/${hospitalId}/schedules/${schedId}/assignments`);

        if (req.query.clearAll === 'true') {
            const snap = await assignColl.get();
            await batchedDelete(snap.docs.map((d) => d.ref));
            logDataModification('CLEAR', 'assignments', schedId, { count: snap.size });
            return res.json({ success: true, removed: snap.size });
        }

        const { staffId, date } = req.query;
        if (!staffId || !date) return res.status(400).json({ error: 'staffId and date or clearAll are required' });

        const dateObj = new Date(date);
        dateObj.setHours(0, 0, 0, 0);
        const snap = await assignColl
            .where('staffId', '==', staffId)
            .where('date', '==', dateObj.toISOString())
            .get();
        if (!snap.empty) {
            await snap.docs[0].ref.delete();
            logDataModification('DELETE', 'assignment', snap.docs[0].id, { staffId, date: dateObj.toISOString() });
        }
        return res.json({ success: true, removed: !snap.empty });
    } catch (err) {
        logError('ASSIGNMENTS_API', 'Failed to delete assignment', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── Validate ──────────────────────────────────────────────────────────────────

// POST /hospitals/:id/schedules/:schedId/validate
router.post('/:schedId/validate', requireAuth, requireHospital, async (req, res) => {
    try {
        const { id: hospitalId, schedId } = req.params;

        const [hospitalSnap, schedSnap] = await Promise.all([
            db.doc(`hospitals/${hospitalId}`).get(),
            db.doc(`hospitals/${hospitalId}/schedules/${schedId}`).get(),
        ]);
        if (!hospitalSnap.exists || !schedSnap.exists) return res.status(404).json({ error: 'Schedule not found' });

        const hospitalData = hospitalSnap.data();
        const schedule = { _id: schedSnap.id, ...schedSnap.data() };

        const [staffSnap, assignSnap] = await Promise.all([
            db.collection(`hospitals/${hospitalId}/staff`).where('wardId', '==', schedule.wardId).get(),
            db.collection(`hospitals/${hospitalId}/schedules/${schedId}/assignments`).where('wardId', '==', schedule.wardId).get(),
        ]);

        let wardGuidelines = {};
        if (schedule.wardId) {
            const wardSnap = await db.doc(`hospitals/${hospitalId}/wards/${schedule.wardId}`).get();
            if (wardSnap.exists) wardGuidelines = wardSnap.data()?.guidelines || {};
        }
        const baseSettings = hospitalData.settings || {};
        const mergedSettings = {
            ...baseSettings,
            minSeniorStaffPerShift:
                wardGuidelines.minSeniorPerShift ??
                baseSettings.minSeniorStaffPerShift ??
                baseSettings.minSeniorStaffPerDay ??
                1,
            minSeniorStaffPerDay:
                wardGuidelines.minSeniorPerShift ??
                baseSettings.minSeniorStaffPerDay ??
                1,
        };

        const { validateFullSchedule } = await import('../lib/validation.js');
        const result = validateFullSchedule({
            staff: staffSnap.docs.map((s) => ({ _id: s.id, ...s.data() })),
            assignments: assignSnap.docs.map((a) => ({ _id: a.id, ...a.data() })),
            settings: mergedSettings,
            schedule,
        });

        return res.json(result);
    } catch (err) {
        logError('VALIDATE_API', 'Failed to validate schedule', err);
        return res.status(500).json({ error: err.message });
    }
});

export default router;
