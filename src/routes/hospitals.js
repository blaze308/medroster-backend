import { Router } from 'express';
import { db, batchedDelete, batchedUpdate, docToJson } from '../config/firebase.js';
import { requireAuth, requireHospital, requireAdmin, requireWriteAccess } from '../middleware/auth.js';
import { findHospitalByJoinCode } from '../lib/hospital-utils.js';
import { isValidJoinCodeFormat, joinCodeKey, normalizeJoinCode } from '../lib/hospital-code.js';
import { ACCOUNT_TYPES } from '../lib/tier-limits.js';
import { hasNameDuplicates, mergeDuplicateOrgUnits, normalizeOrgName } from '../lib/org-dedupe.js';
import { logDataModification, logError } from '../lib/logger.js';

const router = Router();

// GET /hospitals — returns authenticated user's hospital with summary counts.
router.get('/', requireAuth, async (req, res) => {
    try {
        const { hospitalId, accountType } = req.user;
        if (!hospitalId) {
            return res.json([]);
        }
        const snap = await db.doc(`hospitals/${hospitalId}`).get();
        if (!snap.exists) return res.status(404).json({ error: 'Hospital not found' });

        const [depCount, wardCount, staffCount, schedCount] = await Promise.all([
            db.collection(`hospitals/${hospitalId}/departments`).count().get(),
            db.collection(`hospitals/${hospitalId}/wards`).count().get(),
            db.collection(`hospitals/${hospitalId}/staff`).count().get(),
            db.collection(`hospitals/${hospitalId}/schedules`).count().get(),
        ]);

        return res.json([{
            ...docToJson(snap),
            accountType: accountType || ACCOUNT_TYPES.ENTERPRISE,
            counts: {
                departments: depCount.data().count,
                wards: wardCount.data().count,
                staff: staffCount.data().count,
                schedules: schedCount.data().count,
            },
        }]);
    } catch (err) {
        logError('HOSPITALS_API', 'Failed to list hospitals', err);
        return res.status(500).json({ error: err.message });
    }
});

// GET /hospitals/lookup/:code — preview hospital name before joining
router.get('/lookup/:code', requireAuth, async (req, res) => {
    try {
        const hospital = await findHospitalByJoinCode(req.params.code);
        if (!hospital) return res.status(404).json({ error: 'No hospital found for that code' });
        return res.json({
            hospitalId: hospital.id,
            name: hospital.name,
            type: hospital.type,
            region: hospital.region,
            joinCode: hospital.joinCode,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// GET /hospitals/:id — full hospital with departments, wards, and counts.
router.get('/:id', requireAuth, requireHospital, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;
        const snap = await db.doc(`hospitals/${hospitalId}`).get();
        if (!snap.exists) return res.status(404).json({ error: 'Hospital not found' });

        let [deptSnap, wardSnap, staffCount, schedCount] = await Promise.all([
            db.collection(`hospitals/${hospitalId}/departments`).orderBy('name').get(),
            db.collection(`hospitals/${hospitalId}/wards`).orderBy('name').get(),
            db.collection(`hospitals/${hospitalId}/staff`).count().get(),
            db.collection(`hospitals/${hospitalId}/schedules`).count().get(),
        ]);

        let departments = deptSnap.docs.map((d) => ({ _id: d.id, ...d.data() }));
        let wards = wardSnap.docs.map((w) => ({ _id: w.id, ...w.data() }));
        const hasDupes = hasNameDuplicates(departments, (d) => normalizeOrgName(d.name))
            || hasNameDuplicates(wards, (w) => `${w.departmentId}::${normalizeOrgName(w.name)}`);
        if (hasDupes) {
            await mergeDuplicateOrgUnits(hospitalId);
            [deptSnap, wardSnap, staffCount, schedCount] = await Promise.all([
                db.collection(`hospitals/${hospitalId}/departments`).orderBy('name').get(),
                db.collection(`hospitals/${hospitalId}/wards`).orderBy('name').get(),
                db.collection(`hospitals/${hospitalId}/staff`).count().get(),
                db.collection(`hospitals/${hospitalId}/schedules`).count().get(),
            ]);
            departments = deptSnap.docs.map((d) => ({ _id: d.id, ...d.data() }));
            wards = wardSnap.docs.map((w) => ({ _id: w.id, ...w.data() }));
        }

        const data = docToJson(snap);
        if (req.user.role === 'staff') {
            delete data.joinCode;
            delete data.joinCodeKey;
        }

        return res.json({
            ...data,
            departments,
            wards,
            counts: {
                departments: departments.length,
                wards: wards.length,
                staff: staffCount.data().count,
                schedules: schedCount.data().count,
            },
        });
    } catch (err) {
        logError('HOSPITALS_API', 'Failed to fetch hospital', err);
        return res.status(500).json({ error: err.message });
    }
});

// PATCH /hospitals/:id — update hospital fields or settings.
router.patch('/:id', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;
        const allowed = ['name', 'type', 'region', 'location', 'ghsCode', 'shiftTypes', 'settings'];
        const update = { updatedAt: new Date().toISOString() };
        for (const key of allowed) {
            if (req.body[key] !== undefined) update[key] = req.body[key];
        }
        if (update.settings && typeof update.settings === 'object') {
            const incoming = update.settings;
            const vr = incoming.validationRules || {};
            const minSenior = Math.max(
                0,
                incoming.minSeniorStaffPerShift ?? incoming.minSeniorStaffPerDay ?? 1
            );
            update.settings = {
                ...incoming,
                minSeniorStaffPerDay: minSenior,
                minSeniorStaffPerShift: minSenior,
                supervisoryCoverageSeverity: incoming.supervisoryCoverageSeverity || 'warning',
                validationRules: {
                    ...vr,
                    enforceLeaveConflicts: true,
                    enforceRoleShiftRestrictions: true,
                    enforceSupervisoryCoverage: true,
                },
            };
        }

        const ref = db.doc(`hospitals/${hospitalId}`);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Hospital not found' });

        await ref.update(update);
        const updated = await ref.get();

        logDataModification('UPDATE', 'hospital', hospitalId, { fields: Object.keys(update) });
        return res.json(docToJson(updated));
    } catch (err) {
        logError('HOSPITALS_API', 'Failed to update hospital', err);
        return res.status(500).json({ error: err.message });
    }
});

// PATCH /hospitals/:id/join-code — admin edits join code
router.patch('/:id/join-code', requireAuth, requireHospital, requireAdmin, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;
        const { newCode } = req.body;
        if (!newCode || !isValidJoinCodeFormat(newCode)) {
            return res.status(400).json({
                error: 'Join code must be 6–9 alphanumeric characters (e.g. KBU-X7F or KORLEBU)',
            });
        }

        let normalized = normalizeJoinCode(newCode);
        const key = joinCodeKey(normalized);
        if (key.length === 6 && !normalized.includes('-')) {
            normalized = `${key.slice(0, 3)}-${key.slice(3)}`;
        }

        const clash = await db.collection('hospitals').where('joinCodeKey', '==', key).limit(1).get();
        if (!clash.empty && clash.docs[0].id !== hospitalId) {
            return res.status(409).json({ error: 'That join code is already taken' });
        }

        const ref = db.doc(`hospitals/${hospitalId}`);
        await ref.update({
            joinCode: normalized,
            joinCodeKey: key,
            updatedAt: new Date().toISOString(),
        });

        const updated = await ref.get();
        logDataModification('UPDATE', 'hospital-join-code', hospitalId, { joinCode: updated.data().joinCode });
        return res.json({ success: true, joinCode: updated.data().joinCode });
    } catch (err) {
        logError('HOSPITALS_API', 'Failed to update join code', err);
        return res.status(500).json({ error: err.message });
    }
});

// DELETE /hospitals/:id — delete hospital and all subcollections.
router.delete('/:id', requireAuth, requireHospital, requireAdmin, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;
        const hospitalRef = db.doc(`hospitals/${hospitalId}`);
        const snap = await hospitalRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Hospital not found' });

        const schedSnap = await db.collection(`hospitals/${hospitalId}/schedules`).get();
        for (const schedDoc of schedSnap.docs) {
            const assignSnap = await schedDoc.ref.collection('assignments').get();
            await batchedDelete(assignSnap.docs.map((d) => d.ref));
            await schedDoc.ref.delete();
        }

        const [deptSnap, wardSnap, staffSnap] = await Promise.all([
            db.collection(`hospitals/${hospitalId}/departments`).get(),
            db.collection(`hospitals/${hospitalId}/wards`).get(),
            db.collection(`hospitals/${hospitalId}/staff`).get(),
        ]);

        await batchedDelete([
            ...deptSnap.docs.map((d) => d.ref),
            ...wardSnap.docs.map((d) => d.ref),
            ...staffSnap.docs.map((d) => d.ref),
            hospitalRef,
        ]);

        const usersSnap = await db.collection('users').where('hospitalId', '==', hospitalId).get();
        const now = new Date().toISOString();
        await batchedUpdate(usersSnap.docs.map((u) => ({
            ref: u.ref,
            data: {
                hospitalId: null,
                accountType: ACCOUNT_TYPES.INDIVIDUAL,
                role: null,
                updatedAt: now,
            },
        })));

        logDataModification('DELETE', 'hospital', hospitalId, { name: snap.data().name });
        return res.json({ success: true });
    } catch (err) {
        logError('HOSPITALS_API', 'Failed to delete hospital', err);
        return res.status(500).json({ error: err.message });
    }
});

export default router;
