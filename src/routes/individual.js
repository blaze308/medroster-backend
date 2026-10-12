import { Router } from 'express';
import { db } from '../config/firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { ACCOUNT_TYPES, getTierLimits, scheduleDayCount } from '../lib/tier-limits.js';
import { buildStaffCsvTemplate, mapCsvRowToStaff, parseCsv } from '../lib/staff-csv.js';
import { extractRosterPreview } from '../lib/roster-ingest.js';
import { logDataModification, logError } from '../lib/logger.js';

const router = Router({ mergeParams: true });

function assertIndividual(req, res) {
    const type = req.user.accountType || ACCOUNT_TYPES.INDIVIDUAL;
    if (type === ACCOUNT_TYPES.ENTERPRISE && req.user.hospitalId) {
        res.status(400).json({ error: 'Use hospital schedule APIs for enterprise accounts' });
        return false;
    }
    return true;
}

function schedColl(uid) {
    return db.collection(`users/${uid}/schedules`);
}

// GET /api/me/schedules
router.get('/schedules', requireAuth, async (req, res) => {
    try {
        if (!assertIndividual(req, res)) return;
        const snap = await schedColl(req.user.uid).orderBy('startDate', 'desc').get();
        return res.json(snap.docs.map((d) => ({ _id: d.id, ...d.data() })));
    } catch (err) {
        logError('INDIVIDUAL_API', 'List schedules failed', err);
        return res.status(500).json({ error: err.message });
    }
});

// POST /api/me/schedules
router.post('/schedules', requireAuth, async (req, res) => {
    try {
        if (!assertIndividual(req, res)) return;
        const limits = getTierLimits(req.user.accountType || ACCOUNT_TYPES.INDIVIDUAL);
        const existing = await schedColl(req.user.uid).count().get();
        if (existing.data().count >= limits.maxSchedules) {
            return res.status(403).json({
                error: `Individual accounts are limited to ${limits.maxSchedules} schedules`,
            });
        }

        const { name, startDate, endDate, staff = [], assignments = [], holidays = [] } = req.body;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate and endDate are required' });
        }
        const days = scheduleDayCount(startDate, endDate);
        if (days > limits.maxScheduleDays) {
            return res.status(403).json({
                error: `Schedules are limited to ${limits.maxScheduleDays} days on this account`,
            });
        }
        if (Array.isArray(staff) && staff.length > limits.maxStaff) {
            return res.status(403).json({ error: `Max ${limits.maxStaff} staff on this account` });
        }

        const now = new Date().toISOString();
        const ref = schedColl(req.user.uid).doc();
        const doc = {
            name: name || 'Schedule',
            startDate,
            endDate,
            staff,
            assignments,
            holidays,
            createdAt: now,
            updatedAt: now,
        };
        await ref.set(doc);
        logDataModification('CREATE', 'individual-schedule', ref.id, { uid: req.user.uid });
        return res.status(201).json({ _id: ref.id, ...doc });
    } catch (err) {
        logError('INDIVIDUAL_API', 'Create schedule failed', err);
        return res.status(500).json({ error: err.message });
    }
});

// GET /api/me/schedules/:schedId
router.get('/schedules/:schedId', requireAuth, async (req, res) => {
    try {
        if (!assertIndividual(req, res)) return;
        const snap = await schedColl(req.user.uid).doc(req.params.schedId).get();
        if (!snap.exists) return res.status(404).json({ error: 'Schedule not found' });
        return res.json({ _id: snap.id, ...snap.data() });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// PATCH /api/me/schedules/:schedId
router.patch('/schedules/:schedId', requireAuth, async (req, res) => {
    try {
        if (!assertIndividual(req, res)) return;
        const limits = getTierLimits(req.user.accountType || ACCOUNT_TYPES.INDIVIDUAL);
        const ref = schedColl(req.user.uid).doc(req.params.schedId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Schedule not found' });

        const allowed = ['name', 'startDate', 'endDate', 'staff', 'assignments', 'holidays'];
        const update = { updatedAt: new Date().toISOString() };
        for (const key of allowed) {
            if (req.body[key] !== undefined) update[key] = req.body[key];
        }

        const start = update.startDate || snap.data().startDate;
        const end = update.endDate || snap.data().endDate;
        if (scheduleDayCount(start, end) > limits.maxScheduleDays) {
            return res.status(403).json({
                error: `Schedules are limited to ${limits.maxScheduleDays} days on this account`,
            });
        }
        if (update.staff && update.staff.length > limits.maxStaff) {
            return res.status(403).json({ error: `Max ${limits.maxStaff} staff on this account` });
        }

        await ref.update(update);
        const updated = await ref.get();
        return res.json({ _id: updated.id, ...updated.data() });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// DELETE /api/me/schedules/:schedId
router.delete('/schedules/:schedId', requireAuth, async (req, res) => {
    try {
        if (!assertIndividual(req, res)) return;
        const ref = schedColl(req.user.uid).doc(req.params.schedId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Schedule not found' });
        await ref.delete();
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

function decodeUploadedFile(body) {
    const raw = body.fileBase64 || body.csvText;
    if (!raw) return null;
    const b64 = String(raw).includes(',') ? String(raw).split(',').pop() : String(raw);
    try {
        return Buffer.from(b64, body.csvText && !body.fileBase64 ? 'utf8' : 'base64');
    } catch {
        return null;
    }
}

// GET /api/me/staff/template — CSV template
router.get('/staff/template', requireAuth, (_req, res) => {
    const csv = buildStaffCsvTemplate();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="medroster-staff-template.csv"');
    return res.send(csv);
});

// POST /api/me/staff/extract — roster preview (docx/xlsx/pdf/image); client merges into schedule
router.post('/staff/extract', requireAuth, async (req, res) => {
    const t0 = Date.now();
    const fileName = req.body.fileName || '';
    try {
        if (!assertIndividual(req, res)) return;
        const limits = getTierLimits(req.user.accountType || ACCOUNT_TYPES.INDIVIDUAL);
        if (!limits.allowDataExtraction) {
            return res.status(403).json({ error: 'Roster extract is not available on this plan' });
        }
        const buf = decodeUploadedFile(req.body);
        console.log(`[INDIVIDUAL_API] POST extract start file=${fileName} bodyBytes≈${buf?.length || 0}`);
        if (!buf || buf.length < 32) return res.status(400).json({ error: 'Upload a duty roster file' });
        const preview = await extractRosterPreview({ buffer: buf, fileName });
        if (!preview.staff?.length) return res.status(400).json({ error: 'No staff rows found in that roster' });
        const staff = (preview.staff || []).slice(0, limits.maxStaff);
        console.log(`[INDIVIDUAL_API] POST extract OK in ${Date.now() - t0}ms staff=${staff.length}`);
        return res.json({ ...preview, staff, source: preview.source || 'roster' });
    } catch (err) {
        console.error(`[INDIVIDUAL_API] POST extract FAIL in ${Date.now() - t0}ms`, err.message);
        logError('INDIVIDUAL_API', 'Roster extract failed', err);
        return res.status(400).json({ error: err.message || 'Could not read that roster' });
    }
});

// POST /api/me/staff/import — parse CSV into staff objects (caller merges into schedule)
router.post('/staff/import', requireAuth, async (req, res) => {
    try {
        if (!assertIndividual(req, res)) return;
        const limits = getTierLimits(req.user.accountType || ACCOUNT_TYPES.INDIVIDUAL);
        const { csvText, fileBase64 } = req.body;
        let text = csvText;
        if (!text && fileBase64) {
            text = Buffer.from(fileBase64, 'base64').toString('utf8');
        }
        if (!text) return res.status(400).json({ error: 'csvText or fileBase64 is required' });

        const rows = parseCsv(text);
        const imported = [];
        const errors = [];
        rows.forEach((row, idx) => {
            const mapped = mapCsvRowToStaff(row);
            if (mapped.errors.length) {
                errors.push({ row: idx + 2, reason: mapped.errors.join('; ') });
                return;
            }
            imported.push({
                firstName: mapped.firstName,
                lastName: mapped.lastName,
                rank: mapped.rank,
                phone: mapped.phone,
                email: mapped.email,
                annualLeaveDays: mapped.annualLeaveDays,
                notes: mapped.notes,
                departmentName: mapped.departmentName,
                wardName: mapped.wardName,
            });
        });

        if (imported.length > limits.maxStaff) {
            return res.status(403).json({
                error: `Import would exceed max ${limits.maxStaff} staff`,
                imported: 0,
                failed: rows.length,
                preview: imported.slice(0, 5),
                errors,
            });
        }

        return res.json({
            imported: imported.length,
            failed: errors.length,
            staff: imported,
            errors,
        });
    } catch (err) {
        logError('INDIVIDUAL_API', 'Staff import failed', err);
        return res.status(500).json({ error: err.message });
    }
});

export default router;
