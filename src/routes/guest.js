import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { buildStaffCsvTemplate, mapCsvRowToStaff, parseCsv } from '../lib/staff-csv.js';
import { TIER_LIMITS } from '../lib/tier-limits.js';
import { extractRosterPreview } from '../lib/roster-ingest.js';
import { logError } from '../lib/logger.js';

const router = Router();

const extractLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    message: { error: 'Too many roster extracts — try again in a few minutes' },
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

// GET /api/guest/staff/template — public CSV template
router.get('/staff/template', (_req, res) => {
    const csv = buildStaffCsvTemplate();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="medroster-staff-template.csv"');
    return res.send(csv);
});

// POST /api/guest/staff/extract — roster preview (docx/xlsx/pdf/image); guest stores result locally
router.post('/staff/extract', extractLimiter, async (req, res) => {
    const t0 = Date.now();
    const fileName = req.body.fileName || '';
    try {
        const buf = decodeUploadedFile(req.body);
        console.log(`[GUEST_API] POST extract start file=${fileName} bodyBytes≈${buf?.length || 0}`);
        if (!buf || buf.length < 32) return res.status(400).json({ error: 'Upload a duty roster file' });
        const preview = await extractRosterPreview({ buffer: buf, fileName });
        if (!preview.staff?.length) return res.status(400).json({ error: 'No staff rows found in that roster' });
        const maxStaff = TIER_LIMITS.guest.maxStaff;
        const staff = (preview.staff || []).slice(0, maxStaff);
        console.log(`[GUEST_API] POST extract OK in ${Date.now() - t0}ms staff=${staff.length}`);
        return res.json({ ...preview, staff, source: preview.source || 'roster' });
    } catch (err) {
        console.error(`[GUEST_API] POST extract FAIL in ${Date.now() - t0}ms`, err.message);
        logError('GUEST_API', 'Roster extract failed', err);
        return res.status(400).json({ error: err.message || 'Could not read that roster' });
    }
});

// POST /api/guest/staff/import — parse only (guest stores in localStorage)
router.post('/staff/import', (req, res) => {
    try {
        const { csvText, fileBase64 } = req.body;
        let text = csvText;
        if (!text && fileBase64) {
            text = Buffer.from(fileBase64, 'base64').toString('utf8');
        }
        if (!text) return res.status(400).json({ error: 'csvText or fileBase64 is required' });

        const maxStaff = TIER_LIMITS.guest.maxStaff;
        const rows = parseCsv(text);
        const imported = [];
        const errors = [];
        rows.forEach((row, idx) => {
            const mapped = mapCsvRowToStaff(row);
            if (mapped.errors.length) {
                errors.push({ row: idx + 2, reason: mapped.errors.join('; ') });
                return;
            }
            if (imported.length >= maxStaff) {
                errors.push({ row: idx + 2, reason: `Guest limit of ${maxStaff} staff reached` });
                return;
            }
            imported.push({
                _id: `guest_${Date.now()}_${idx}`,
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

        return res.json({
            imported: imported.length,
            failed: errors.length,
            staff: imported,
            errors,
            limits: TIER_LIMITS.guest,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// GET /api/guest/limits
router.get('/limits', (_req, res) => res.json(TIER_LIMITS.guest));

export default router;
