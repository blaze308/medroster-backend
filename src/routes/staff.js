import { Router } from 'express';
import { randomUUID } from 'crypto';
import { db, batchedDelete, batchedSet } from '../config/firebase.js';
import { requireAuth, requireHospital, requireWriteAccess } from '../middleware/auth.js';
import { classifyStaffType, compareStaffName } from '../lib/staff-utils.js';
import { buildStaffCsvTemplate, mapCsvRowToStaff, parseCsv } from '../lib/staff-csv.js';
import { categoryFromRank, expandRank, splitFullName } from '../lib/rank-abbr.js';
import { extractRosterPreview } from '../lib/roster-ingest.js';
import { applyRosterSetup, buildSetupProposal } from '../lib/roster-setup.js';
import { getTierLimits } from '../lib/tier-limits.js';
import { logDataModification, logError } from '../lib/logger.js';

const router = Router({ mergeParams: true });

const STAFF_PII_KEYS = [
    'ghanaCardNumber', 'employeeId', 'dateOfBirth', 'address',
    'licenseType', 'licenseNumber', 'licenseExpiry', 'emergencyContact',
];

function omitPii(data) {
    const out = { ...data };
    for (const k of STAFF_PII_KEYS) delete out[k];
    return out;
}

function serializeStaff(id, data, wardsMap) {
    const wardId = data.wardId || (data.departmentId && wardsMap ? wardsMap.get(data.departmentId) : '') || '';
    const slim = omitPii(data);
    return {
        _id: id,
        ...slim,
        wardId,
        fullName: `${data.firstName || ''} ${data.lastName || ''}`.trim(),
    };
}

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

// GET /hospitals/:id/staff?departmentId=...&wardId=...
router.get('/', requireAuth, requireHospital, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;
        const { departmentId, wardId } = req.query;

        const [staffSnap, wardSnap] = await Promise.all([
            db.collection(`hospitals/${hospitalId}/staff`).get(),
            db.collection(`hospitals/${hospitalId}/wards`).get(),
        ]);

        const wardsMap = new Map(wardSnap.docs.map((w) => [w.data().departmentId, w.id]));
        const staff = staffSnap.docs
            .map((d) => serializeStaff(d.id, d.data(), wardsMap))
            .filter((s) => {
                if (departmentId && String(s.departmentId) !== String(departmentId)) return false;
                if (wardId && String(s.wardId) !== String(wardId)) return false;
                return true;
            })
            .sort(compareStaffName);
        return res.json(staff);
    } catch (err) {
        logError('STAFF_API', 'Failed to list staff', err);
        return res.status(500).json({ error: err.message });
    }
});

// GET /hospitals/:id/staff/template/download — must be before /:staffId
router.get('/template/download', requireAuth, requireHospital, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;
        const [deptSnap, wardSnap] = await Promise.all([
            db.collection(`hospitals/${hospitalId}/departments`).orderBy('name').get(),
            db.collection(`hospitals/${hospitalId}/wards`).orderBy('name').get(),
        ]);
        const csv = buildStaffCsvTemplate({
            departments: deptSnap.docs.map((d) => d.data()),
            wards: wardSnap.docs.map((w) => w.data()),
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="medroster-staff-template.csv"');
        return res.send(csv);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// POST /hospitals/:id/staff/import
router.post('/import', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;
        const { csvText, fileBase64, defaultDepartmentId, defaultWardId, staff: staffRows } = req.body;
        let rows = [];
        if (Array.isArray(staffRows) && staffRows.length) {
            rows = staffRows
                .filter((s) => s.selected !== false)
                .map((s) => {
                    const names = s.firstName ? s : splitFullName(s.fullName);
                    const ranks = expandRank(s.rankFull || s.rank || s.rankAbbr);
                    return {
                        firstName: names.firstName,
                        lastName: names.lastName,
                        rank: ranks.rankFull || s.rank,
                        phone: s.phone || '',
                        email: s.email || '',
                        departmentName: s.departmentName,
                        wardName: s.wardName,
                        annualLeaveDays: s.annualLeaveDays,
                        notes: s.notes || '',
                        errors: (!names.firstName || !names.lastName) ? ['Missing name'] : [],
                    };
                });
        } else {
            let text = csvText;
            if (!text && fileBase64) {
                text = Buffer.from(String(fileBase64).split(',').pop(), 'base64').toString('utf8');
            }
            if (!text) return res.status(400).json({ error: 'csvText, fileBase64, or staff rows are required' });
            rows = parseCsv(text).map((row) => {
                const mapped = mapCsvRowToStaff(row);
                const ranks = expandRank(mapped.rank);
                return { ...mapped, rank: ranks.rankFull || mapped.rank };
            });
        }

        const [deptSnap, wardSnap, staffCount] = await Promise.all([
            db.collection(`hospitals/${hospitalId}/departments`).get(),
            db.collection(`hospitals/${hospitalId}/wards`).get(),
            db.collection(`hospitals/${hospitalId}/staff`).count().get(),
        ]);
        const depts = deptSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const wards = wardSnap.docs.map((w) => ({ id: w.id, ...w.data() }));
        const findDept = (name) => depts.find((d) => d.name?.toLowerCase() === name?.toLowerCase());
        const findWard = (name, deptId) => wards.find((w) =>
            w.name?.toLowerCase() === name?.toLowerCase()
            && (!deptId || w.departmentId === deptId));

        const limits = getTierLimits(req.user.accountType || 'enterprise');
        const errors = [];
        let imported = 0;
        const now = new Date().toISOString();

        for (let idx = 0; idx < rows.length; idx++) {
            if (staffCount.data().count + imported >= limits.maxStaff) {
                errors.push({ row: idx + 2, reason: `Staff limit (${limits.maxStaff}) reached` });
                break;
            }
            const mapped = rows[idx];
            if (mapped.errors?.length) {
                errors.push({ row: idx + 2, reason: mapped.errors.join('; ') });
                continue;
            }
            const dept = mapped.departmentName ? findDept(mapped.departmentName) : null;
            const departmentId = dept?.id || defaultDepartmentId;
            const ward = mapped.wardName ? findWard(mapped.wardName, departmentId) : null;
            const wardId = ward?.id || defaultWardId;
            if (!departmentId || !wardId) {
                errors.push({ row: idx + 2, reason: 'Department/ward not found — set defaults or match template names' });
                continue;
            }

            const ref = db.collection(`hospitals/${hospitalId}/staff`).doc();
            await ref.set({
                hospitalId,
                departmentId,
                wardId,
                firstName: mapped.firstName,
                lastName: mapped.lastName,
                phone: mapped.phone,
                email: mapped.email,
                rank: mapped.rank,
                category: 'Nurse',
                staffType: classifyStaffType(mapped.rank),
                annualLeaveEntitlement: mapped.annualLeaveDays || 0,
                employmentStatus: 'Active',
                wardRole: 'regular',
                workRestriction: 'none',
                leaveRecords: [],
                notes: mapped.notes || '',
                createdAt: now,
                updatedAt: now,
            });
            imported++;
        }

        logDataModification('IMPORT', 'staff', hospitalId, { imported, failed: errors.length });
        return res.json({ imported, failed: errors.length, errors });
    } catch (err) {
        logError('STAFF_API', 'Import failed', err);
        return res.status(500).json({ error: err.message });
    }
});

function previewFromCsvText(text) {
    const rows = parseCsv(text);
    return rows.map((row, idx) => {
        const mapped = mapCsvRowToStaff(row);
        const ranks = expandRank(mapped.rank);
        return {
            key: `csv-${idx}`,
            firstName: mapped.firstName,
            lastName: mapped.lastName,
            rank: ranks.rankFull || mapped.rank,
            rankAbbr: ranks.rankAbbr,
            phone: mapped.phone,
            email: mapped.email,
            notes: mapped.notes,
            annualLeaveDays: mapped.annualLeaveDays,
            departmentName: mapped.departmentName,
            wardName: mapped.wardName,
            selected: mapped.errors.length === 0,
            errors: mapped.errors,
        };
    });
}

// POST /hospitals/:id/staff/parse-csv — preview only
router.post('/parse-csv', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { csvText, fileBase64 } = req.body;
        let text = csvText;
        if (!text && fileBase64) text = Buffer.from(String(fileBase64).split(',').pop(), 'base64').toString('utf8');
        if (!text) return res.status(400).json({ error: 'csvText or fileBase64 is required' });
        return res.json({ source: 'csv', staff: previewFromCsvText(text) });
    } catch (err) {
        logError('STAFF_API', 'CSV parse failed', err);
        return res.status(500).json({ error: err.message });
    }
});

// POST /hospitals/:id/staff/extract — roster preview (docx/xlsx/pdf/image), does not write
router.post('/extract', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    const t0 = Date.now();
    const fileName = req.body.fileName || '';
    try {
        const { id: hospitalId } = req.params;
        const buf = decodeUploadedFile(req.body);
        console.log(`[STAFF_API] POST extract start file=${fileName} bodyBytes≈${buf?.length || 0}`);
        if (!buf || buf.length < 32) return res.status(400).json({ error: 'Upload a duty roster file' });
        const preview = await extractRosterPreview({ buffer: buf, fileName });
        if (!preview.staff?.length) return res.status(400).json({ error: 'No staff rows found in that roster' });

        let savedSetup = null;
        const wardId = String(req.body.wardId || '').trim();
        if (wardId) {
            const wardSnap = await db.doc(`hospitals/${hospitalId}/wards/${wardId}`).get();
            if (wardSnap.exists) savedSetup = wardSnap.data()?.rosterSetup || null;
        }
        const proposal = buildSetupProposal(preview, savedSetup);
        console.log(`[STAFF_API] POST extract OK in ${Date.now() - t0}ms staff=${preview.staff.length} codes=${proposal.codes.length}`);
        return res.json({
            ...preview,
            codes: proposal.codes,
            legendDraft: proposal.legendDraft,
            roleGuesses: proposal.roleGuesses,
            blanks: proposal.blanks,
            needsFullSetup: proposal.needsFullSetup,
            savedSetup: proposal.savedSetup,
            source: preview.source || 'roster',
        });
    } catch (err) {
        console.error(`[STAFF_API] POST extract FAIL in ${Date.now() - t0}ms`, err.message);
        logError('STAFF_API', 'Roster extract failed', err);
        return res.status(400).json({ error: err.message || 'Could not read that roster' });
    }
});

// POST /hospitals/:id/staff/remap-roster — apply confirmed legend/roles; no OpenAI
router.post('/remap-roster', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { preview, setup } = req.body || {};
        if (!preview?.staff?.length) return res.status(400).json({ error: 'preview.staff is required' });
        const remapped = applyRosterSetup(preview, setup || {});
        return res.json(remapped);
    } catch (err) {
        logError('STAFF_API', 'Roster remap failed', err);
        return res.status(400).json({ error: err.message || 'Could not remap that roster' });
    }
});

function shiftFromCode(shiftTypes, code) {
    const map = { M: 'Morning', A: 'Afternoon', N: 'Night', SOD: 'SOD' };
    const name = map[String(code || '').toUpperCase()];
    if (!name) return null;
    return (shiftTypes || []).find((st) => st.name === name || st.id === name.toLowerCase()) || null;
}

async function upsertSlimStaff({ hospitalId, departmentId, wardId, row, now }) {
    const rank = (row.rankFull || row.rank || '').trim();
    const firstName = (row.firstName || '').trim();
    const lastName = (row.lastName || '').trim();
    const payload = {
        hospitalId,
        departmentId,
        wardId,
        firstName,
        lastName,
        phone: row.phone?.trim() || '',
        email: row.email?.trim() || '',
        rank,
        category: row.category || categoryFromRank(rank) || 'Nurse',
        staffType: classifyStaffType(rank),
        annualLeaveBalance: Number(row.annualLeaveDays ?? row.annualLeaveBalance) || 15,
        employmentStatus: row.leaveType && /maternity|study/i.test(row.leaveType) ? 'On Leave' : 'Active',
        wardRole: row.wardRole || 'regular',
        workRestriction: /study/i.test(row.leaveType || '') ? 'studyLeave' : (row.workRestriction || 'none'),
        noNightShift: Boolean(row.noNightShift),
        maternityNoNight: Boolean(row.maternityNoNight) || /maternity/i.test(row.leaveType || ''),
        preferredOffDays: Array.isArray(row.preferredOffDays) ? row.preferredOffDays : [],
        preferredShifts: Array.isArray(row.preferredShifts) ? row.preferredShifts : [],
        notes: row.notes || row.leaveNote || '',
        updatedAt: now,
    };
    if (row.existingId) {
        await db.doc(`hospitals/${hospitalId}/staff/${row.existingId}`).update(payload);
        return row.existingId;
    }
    const ref = db.collection(`hospitals/${hospitalId}/staff`).doc();
    await ref.set({ ...payload, leaveRecords: row.leaveRecords || [], createdAt: now });
    return ref.id;
}

function cellToken(cell) {
    return String(cell?.code || cell?.text || '').toUpperCase().replace(/\s+/g, '');
}

function isLeaveCell(cell) {
    const token = cellToken(cell);
    return token === 'L' || token === 'LV' || token.includes('LEAVE');
}

function isOffOrHolidayCell(cell) {
    const token = cellToken(cell);
    return token === 'O' || token === 'H' || token === 'OFF' || token === 'D/O' || token === 'N/O' || token === 'H/O';
}

function nextDateKey(dateKey) {
    const d = new Date(`${dateKey}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
}

function leaveRunsFromRow(row) {
    const dates = [...new Set((row.cells || []).filter((c) => c.date && isLeaveCell(c)).map((c) => c.date))].sort();
    const runs = [];
    let start = null;
    let prev = null;
    const flush = () => {
        if (!start) return;
        runs.push({
            id: randomUUID(),
            startDate: `${start}T00:00:00.000Z`,
            endDate: `${prev}T23:59:59.000Z`,
            leaveType: row.leaveType || 'Leave',
            status: 'Approved',
            notes: row.leaveNote || '',
        });
        start = null;
        prev = null;
    };
    for (const date of dates) {
        if (!start) {
            start = date;
            prev = date;
            continue;
        }
        if (date === nextDateKey(prev)) {
            prev = date;
            continue;
        }
        flush();
        start = date;
        prev = date;
    }
    flush();
    return runs;
}

function dateKeysInLeaveRuns(runs) {
    const keys = new Set();
    for (const run of runs) {
        let cursor = run.startDate.split('T')[0];
        const end = run.endDate.split('T')[0];
        while (cursor <= end) {
            keys.add(cursor);
            cursor = nextDateKey(cursor);
        }
    }
    return keys;
}

// POST /hospitals/:id/staff/import-roster — confirm extract into staff + draft schedule
router.post('/import-roster', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;
        const {
            staff: staffRows = [],
            days = [],
            defaultDepartmentId,
            defaultWardId,
            createSchedule = true,
            rules: importRules = {},
        } = req.body;
        const rules = {
            leaveStayOff: importRules.leaveStayOff !== false,
            offAndHolidayStayOff: importRules.offAndHolidayStayOff !== false,
            keepGridAsIs: importRules.keepGridAsIs !== false,
        };

        if (!defaultDepartmentId || !defaultWardId) {
            return res.status(400).json({ error: 'Department and ward are required' });
        }
        const [deptSnap, wardSnap, hospitalSnap, existingSnap] = await Promise.all([
            db.doc(`hospitals/${hospitalId}/departments/${defaultDepartmentId}`).get(),
            db.doc(`hospitals/${hospitalId}/wards/${defaultWardId}`).get(),
            db.doc(`hospitals/${hospitalId}`).get(),
            db.collection(`hospitals/${hospitalId}/staff`).get(),
        ]);
        if (!deptSnap.exists) return res.status(404).json({ error: 'Department not found' });
        if (!wardSnap.exists) return res.status(404).json({ error: 'Ward not found' });
        if (!hospitalSnap.exists) return res.status(404).json({ error: 'Hospital not found' });

        const limits = getTierLimits(req.user.accountType || 'enterprise');
        const byName = new Map();
        existingSnap.docs.forEach((d) => {
            const x = d.data();
            byName.set(`${x.firstName || ''} ${x.lastName || ''}`.trim().toLowerCase(), d);
        });

        const selected = staffRows.filter((s) => s.selected !== false && (s.firstName || s.fullName));
        if (!selected.length) return res.status(400).json({ error: 'No staff rows selected' });
        if (existingSnap.size + selected.filter((s) => !byName.get(`${s.firstName} ${s.lastName}`.trim().toLowerCase())).length > limits.maxStaff) {
            return res.status(400).json({ error: `Staff limit (${limits.maxStaff}) reached` });
        }

        const now = new Date().toISOString();

        let dateList = (days.length ? days : []).map((d) => d.date).filter(Boolean).sort();
        if (dateList.length > 31) dateList = dateList.slice(0, 31);
        const startDate = dateList[0];
        const endDate = dateList[dateList.length - 1];
        const inRange = new Set(dateList);
        const staffIds = [];

        for (const row of selected) {
            const names = row.firstName ? row : splitFullName(row.fullName);
            const ranks = expandRank(row.rankFull || row.rank || row.rankAbbr);
            const nameKey = `${names.firstName} ${names.lastName}`.trim().toLowerCase();
            const existing = byName.get(nameKey);
            const leaveRecords = rules.leaveStayOff ? leaveRunsFromRow(row) : [];
            const id = await upsertSlimStaff({
                hospitalId,
                departmentId: defaultDepartmentId,
                wardId: defaultWardId,
                now,
                row: {
                    ...row,
                    firstName: names.firstName,
                    lastName: names.lastName,
                    rankFull: ranks.rankFull || row.rank,
                    rank: ranks.rankFull || row.rank,
                    existingId: existing?.id,
                    leaveRecords: existing ? undefined : leaveRecords,
                },
            });
            if (existing && leaveRecords.length) {
                const prev = existing.data().leaveRecords || [];
                const merged = [...prev];
                for (const run of leaveRecords) {
                    const already = prev.some((p) => p.startDate === run.startDate && p.endDate === run.endDate);
                    if (!already) merged.push(run);
                }
                await db.doc(`hospitals/${hospitalId}/staff/${id}`).update({
                    leaveRecords: merged,
                });
            }
            staffIds.push({ row, id, leaveRecords });
        }

        let scheduleId = null;
        let assignmentCount = 0;
        const writeSchedule = (createSchedule || rules.keepGridAsIs) && startDate && endDate;
        if (writeSchedule) {
            const start = new Date(`${startDate}T00:00:00.000Z`);
            const end = new Date(`${endDate}T00:00:00.000Z`);
            const holidays = [];
            const holidayDates = new Set();
            if (rules.offAndHolidayStayOff) {
                for (const { row } of staffIds) {
                    for (const cell of row.cells || []) {
                        if (cellToken(cell) === 'H' && cell.date && inRange.has(cell.date) && !holidayDates.has(cell.date)) {
                            holidayDates.add(cell.date);
                            holidays.push({ date: `${cell.date}T00:00:00.000Z`, name: 'Holiday' });
                        }
                    }
                }
            }

            const dupSnap = await db.collection(`hospitals/${hospitalId}/schedules`)
                .where('wardId', '==', defaultWardId)
                .where('startDate', '==', start.toISOString())
                .get();
            let schedRef;
            if (!dupSnap.empty) {
                schedRef = dupSnap.docs[0].ref;
                const existingAssign = await schedRef.collection('assignments').get();
                if (!existingAssign.empty) {
                    await batchedDelete(existingAssign.docs.map((d) => d.ref));
                }
                await schedRef.update({ holidays, updatedAt: now, name: req.body.title || dupSnap.docs[0].data().name });
            } else {
                schedRef = db.collection(`hospitals/${hospitalId}/schedules`).doc();
                await schedRef.set({
                    hospitalId,
                    departmentId: defaultDepartmentId,
                    wardId: defaultWardId,
                    name: req.body.title || `${wardSnap.data().name} duty roster`,
                    startDate: start.toISOString(),
                    endDate: new Date(end.getTime() + 24 * 3600 * 1000 - 1).toISOString(),
                    holidays,
                    status: 'draft',
                    publishedAt: null,
                    createdAt: now,
                    updatedAt: now,
                });
            }
            scheduleId = schedRef.id;

            if (rules.keepGridAsIs) {
                const shiftTypes = hospitalSnap.data().shiftTypes || [];
                const assignDocs = [];
                for (const { row, id, leaveRecords } of staffIds) {
                    const leaveDates = dateKeysInLeaveRuns(leaveRecords || []);
                    for (const a of row.assignments || []) {
                        if (!inRange.has(a.date)) continue;
                        if (rules.leaveStayOff && leaveDates.has(a.date)) continue;
                        const cell = (row.cells || []).find((c) => c.date === a.date);
                        if (rules.offAndHolidayStayOff && (isOffOrHolidayCell(cell) || isLeaveCell(cell))) continue;
                        const shift = shiftFromCode(shiftTypes, a.code);
                        if (!shift) continue;
                        assignDocs.push({
                            scheduleId,
                            hospitalId,
                            staffId: id,
                            departmentId: defaultDepartmentId,
                            wardId: defaultWardId,
                            date: `${a.date}T00:00:00.000Z`,
                            shiftType: { name: shift.name, color: shift.color, startTime: shift.startTime, endTime: shift.endTime },
                            createdAt: now,
                        });
                    }
                }
                if (assignDocs.length) {
                    await batchedSet(schedRef.collection('assignments'), assignDocs);
                    assignmentCount = assignDocs.length;
                }
            }
        }

        logDataModification('IMPORT', 'staff-roster', hospitalId, {
            imported: staffIds.length,
            scheduleId,
            assignmentCount,
        });
        return res.json({
            imported: staffIds.length,
            failed: 0,
            errors: [],
            scheduleId,
            assignmentCount,
        });
    } catch (err) {
        logError('STAFF_API', 'Roster import failed', err);
        return res.status(500).json({ error: err.message });
    }
});

// GET /hospitals/:id/staff/:staffId
router.get('/:staffId', requireAuth, requireHospital, async (req, res) => {
    try {
        const { id: hospitalId, staffId } = req.params;
        const snap = await db.doc(`hospitals/${hospitalId}/staff/${staffId}`).get();
        if (!snap.exists) return res.status(404).json({ error: 'Staff not found' });
        return res.json(serializeStaff(snap.id, snap.data(), null));
    } catch (err) {
        logError('STAFF_API', 'Failed to fetch staff', err);
        return res.status(500).json({ error: err.message });
    }
});

// POST /hospitals/:id/staff
router.post('/', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId } = req.params;
        const body = req.body;

        if (!body.departmentId || !body.wardId) {
            return res.status(400).json({ error: 'Department and ward are required' });
        }
        if (!body.firstName?.trim() || !body.lastName?.trim()) {
            return res.status(400).json({ error: 'First and last name are required' });
        }

        const [hospitalSnap, deptSnap, wardSnap] = await Promise.all([
            db.doc(`hospitals/${hospitalId}`).get(),
            db.doc(`hospitals/${hospitalId}/departments/${body.departmentId}`).get(),
            db.doc(`hospitals/${hospitalId}/wards/${body.wardId}`).get(),
        ]);
        if (!hospitalSnap.exists) return res.status(404).json({ error: 'Hospital not found' });
        if (!deptSnap.exists) return res.status(404).json({ error: 'Department not found' });
        if (!wardSnap.exists) return res.status(404).json({ error: 'Ward not found for this department' });

        const now = new Date().toISOString();
        const rank = body.rank?.trim() || '';
        const staffData = {
            hospitalId,
            departmentId: body.departmentId,
            wardId: body.wardId,
            firstName: body.firstName.trim(),
            lastName: body.lastName.trim(),
            gender: body.gender || '',
            phone: body.phone?.trim() || '',
            email: body.email?.trim() || '',
            category: body.category || categoryFromRank(rank) || 'Nurse',
            rank,
            staffType: classifyStaffType(rank),
            qualification: body.qualification || '',
            specialization: body.specialization?.trim() || '',
            dateHired: body.dateHired || '',
            employmentStatus: body.employmentStatus || 'Active',
            wardRole: body.wardRole || 'regular',
            workRestriction: body.workRestriction || 'none',
            noNightShift: Boolean(body.noNightShift),
            maternityNoNight: Boolean(body.maternityNoNight),
            preferredOffDays: Array.isArray(body.preferredOffDays) ? body.preferredOffDays : [],
            preferredShifts: Array.isArray(body.preferredShifts) ? body.preferredShifts : [],
            annualLeaveBalance: body.annualLeaveBalance ?? 15,
            isRotation: Boolean(body.isRotation),
            leaveRecords: [],
            createdAt: now,
            updatedAt: now,
        };

        const ref = db.collection(`hospitals/${hospitalId}/staff`).doc();
        await ref.set(staffData);

        logDataModification('CREATE', 'staff', ref.id, {
            name: `${staffData.firstName} ${staffData.lastName}`,
            rank: staffData.rank,
        });

        return res.status(201).json(serializeStaff(ref.id, staffData, null));
    } catch (err) {
        logError('STAFF_API', 'Failed to create staff', err);
        return res.status(500).json({ error: err.message });
    }
});

// PATCH /hospitals/:id/staff/:staffId
router.patch('/:staffId', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId, staffId } = req.params;
        const ref = db.doc(`hospitals/${hospitalId}/staff/${staffId}`);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Staff not found' });

        if (req.body.departmentId || req.body.wardId) {
            const current = snap.data();
            const departmentId = req.body.departmentId || current.departmentId;
            const wardId = req.body.wardId || current.wardId;
            const [deptSnap, wardSnap] = await Promise.all([
                db.doc(`hospitals/${hospitalId}/departments/${departmentId}`).get(),
                db.doc(`hospitals/${hospitalId}/wards/${wardId}`).get(),
            ]);
            if (!deptSnap.exists) return res.status(404).json({ error: 'Department not found' });
            if (!wardSnap.exists) return res.status(404).json({ error: 'Ward not found for this department' });
        }

        const allowed = [
            'firstName', 'lastName', 'gender',
            'phone', 'email', 'category', 'rank', 'qualification', 'specialization',
            'dateHired', 'employmentStatus',
            'annualLeaveBalance', 'departmentId', 'wardId',
            'wardRole', 'workRestriction', 'noNightShift', 'maternityNoNight',
            'preferredOffDays', 'preferredShifts', 'isRotation',
        ];
        const update = { updatedAt: new Date().toISOString() };
        for (const k of allowed) {
            if (req.body[k] !== undefined) update[k] = req.body[k];
        }
        if (update.rank) update.staffType = classifyStaffType(update.rank);

        await ref.update(update);
        const updated = await ref.get();

        logDataModification('UPDATE', 'staff', staffId, { fields: Object.keys(update) });
        return res.json(serializeStaff(updated.id, updated.data(), null));
    } catch (err) {
        logError('STAFF_API', 'Failed to update staff', err);
        return res.status(500).json({ error: err.message });
    }
});

// DELETE /hospitals/:id/staff/:staffId
router.delete('/:staffId', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId, staffId } = req.params;
        const ref = db.doc(`hospitals/${hospitalId}/staff/${staffId}`);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Staff not found' });
        const staffData = snap.data();

        const schedSnap = await db.collection(`hospitals/${hospitalId}/schedules`).get();
        const assignmentRefs = [];
        for (const schedDoc of schedSnap.docs) {
            const assignSnap = await schedDoc.ref.collection('assignments').where('staffId', '==', staffId).get();
            assignmentRefs.push(...assignSnap.docs.map((d) => d.ref));
        }
        await batchedDelete(assignmentRefs);
        await ref.delete();

        logDataModification('DELETE', 'staff', staffId, { name: `${staffData.firstName} ${staffData.lastName}` });
        return res.json({ success: true });
    } catch (err) {
        logError('STAFF_API', 'Failed to delete staff', err);
        return res.status(500).json({ error: err.message });
    }
});

// ── Leave sub-resource ──────────────────────────────────────────────────────

// GET /hospitals/:id/staff/:staffId/leave
router.get('/:staffId/leave', requireAuth, requireHospital, async (req, res) => {
    try {
        const { id: hospitalId, staffId } = req.params;
        const snap = await db.doc(`hospitals/${hospitalId}/staff/${staffId}`).get();
        if (!snap.exists) return res.status(404).json({ error: 'Staff not found' });
        return res.json(snap.data().leaveRecords || []);
    } catch (err) {
        logError('LEAVE_API', 'Failed to fetch leave', err);
        return res.status(500).json({ error: err.message });
    }
});

// POST /hospitals/:id/staff/:staffId/leave
router.post('/:staffId/leave', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId, staffId } = req.params;
        const { startDate, endDate, leaveType, notes } = req.body;

        if (!startDate || !endDate) return res.status(400).json({ error: 'Start and end date are required' });
        const start = new Date(startDate);
        const end = new Date(endDate);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return res.status(400).json({ error: 'Invalid date format' });
        if (start > end) return res.status(400).json({ error: 'Start date must be before end date' });

        const ref = db.doc(`hospitals/${hospitalId}/staff/${staffId}`);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Staff not found' });

        const newRecord = {
            id: randomUUID(),
            startDate: start.toISOString(),
            endDate: end.toISOString(),
            leaveType: leaveType || 'Annual',
            status: 'Approved',
            notes: notes || '',
        };

        const existing = snap.data().leaveRecords || [];
        await ref.update({ leaveRecords: [...existing, newRecord], updatedAt: new Date().toISOString() });

        // Remove conflicting assignments in the leave window from all schedules
        const schedSnap = await db.collection(`hospitals/${hospitalId}/schedules`).get();
        let removedAssignments = 0;
        for (const schedDoc of schedSnap.docs) {
            const assignSnap = await schedDoc.ref.collection('assignments')
                .where('staffId', '==', staffId)
                .get();
            const toDelete = assignSnap.docs.filter((d) => {
                const assignDate = new Date(d.data().date);
                return assignDate >= start && assignDate <= end;
            });
            if (toDelete.length > 0) {
                await batchedDelete(toDelete.map((d) => d.ref));
                removedAssignments += toDelete.length;
            }
        }

        const staffData = snap.data();
        logDataModification('CREATE', 'leave', newRecord.id, {
            staffId,
            staffName: `${staffData.firstName} ${staffData.lastName}`,
            startDate,
            endDate,
            type: newRecord.leaveType,
            removedAssignments,
        });

        return res.json({ leaveRecord: newRecord, removedAssignments });
    } catch (err) {
        logError('LEAVE_API', 'Failed to add leave', err);
        return res.status(500).json({ error: err.message });
    }
});

// DELETE /hospitals/:id/staff/:staffId/leave?leaveId=...
router.delete('/:staffId/leave', requireAuth, requireHospital, requireWriteAccess, async (req, res) => {
    try {
        const { id: hospitalId, staffId } = req.params;
        const { leaveId } = req.query;
        if (!leaveId) return res.status(400).json({ error: 'leaveId is required' });

        const ref = db.doc(`hospitals/${hospitalId}/staff/${staffId}`);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Staff not found' });

        const records = snap.data().leaveRecords || [];
        const filtered = records.filter((l) => l.id !== leaveId);
        if (filtered.length === records.length) return res.status(404).json({ error: 'Leave record not found' });

        await ref.update({ leaveRecords: filtered, updatedAt: new Date().toISOString() });

        const staffData = snap.data();
        logDataModification('DELETE', 'leave', leaveId, {
            staffId,
            staffName: `${staffData.firstName} ${staffData.lastName}`,
        });
        return res.json({ success: true });
    } catch (err) {
        logError('LEAVE_API', 'Failed to remove leave', err);
        return res.status(500).json({ error: err.message });
    }
});

export default router;
