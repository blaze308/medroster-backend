import JSZip from 'jszip';

const WEEKEND_FILLS = new Set(['95B3D7', '8DB3E2']);
const SOD_FILLS = new Set(['E36C0A', 'F79646']);
const STUDY_FILLS = new Set(['D99594']);
const LEAVE_FILLS = new Set(['FFC000', 'FFFF00']);

const DEFAULT_LEGEND = [
    { label: 'MORNING DUTY', fill: '0070C0', meaning: 'Morning' },
    { label: 'AFTERNOON DUTY', fill: '7030A0', meaning: 'Afternoon' },
    { label: 'NIGHT DUTY', fill: '00B050', meaning: 'Night' },
    { label: 'OFF DUTY', fill: 'FF0000', meaning: 'Off' },
    { label: 'DAY SUP', fill: '0070C0', meaning: 'Morning' },
    { label: 'STUDY LEAVE', fill: 'D99594', meaning: 'Leave' },
    { label: 'SOD', fill: 'E36C0A', meaning: 'SOD' },
];

const LEAVE_PHRASES = [
    { re: /MATERNITY\s*LEAVE/i, type: 'Maternity' },
    { re: /PART\s*LEAVE/i, type: 'Part' },
    { re: /STUDY\s*LEAVE/i, type: 'Study' },
    { re: /ANNUAL\s*LEAVE/i, type: 'Annual' },
    { re: /SICK\s*LEAVE/i, type: 'Sick' },
];

function cellsFromTableXml(tableXml) {
    const rows = [];
    const trRe = /<w:tr[\s>][\s\S]*?<\/w:tr>/g;
    let tr;
    while ((tr = trRe.exec(tableXml))) {
        const rowXml = tr[0];
        const cells = [];
        const tcRe = /<w:tc[\s>][\s\S]*?<\/w:tc>/g;
        let tc;
        while ((tc = tcRe.exec(rowXml))) {
            const cxml = tc[0];
            const fillM = cxml.match(/w:fill="([A-Fa-f0-9]+)"/);
            const colorM = cxml.match(/w:color w:val="([A-Fa-f0-9]+)"/);
            let text = '';
            const tRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
            let tm;
            while ((tm = tRe.exec(cxml))) text += tm[1];
            cells.push({
                text: text.replace(/\s+/g, ' ').trim(),
                fill: fillM ? fillM[1].toUpperCase() : '',
                color: colorM ? colorM[1].toUpperCase() : '',
            });
        }
        rows.push(cells);
    }
    return rows;
}

function extractParagraphText(xml) {
    const texts = [];
    const tRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let tm;
    while ((tm = tRe.exec(xml))) texts.push(tm[1]);
    return texts.join('').replace(/\s+/g, ' ').trim();
}

function findDateRow(rows) {
    const withDateLabel = rows.find((r) => r.some((c) => /DATE/i.test(c.text)) && r.filter((c) => /^\d{1,2}$/.test(c.text)).length >= 7);
    if (withDateLabel) return withDateLabel;
    return rows.find((r) => r.some((c) => /^RANK$/i.test(c.text)) && r.filter((c) => /^\d{1,2}$/.test(c.text)).length >= 7);
}

function findDayRow(rows) {
    return rows.find((r) => r.some((c) => /^DAY$/i.test(c.text)));
}

function parseTitle(text) {
    const m = text.match(/(.+?)\s+DUTY ROSTER,?\s+([A-Z]+),?\s+(\d{4})/i);
    if (!m) return { title: text, unit: '', month: '', year: null };
    return { title: text, unit: m[1].trim(), month: m[2].trim(), year: Number(m[3]) };
}

const MONTHS = {
    JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5,
    JULY: 6, AUGUST: 7, SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11,
};

function detectLegend(rows) {
    const legend = [];
    const seen = new Set();
    for (const r of rows) {
        for (const c of r) {
            const label = c.text.toUpperCase();
            if (!label) continue;
            const hit = DEFAULT_LEGEND.find((l) => label === l.label || label.includes(l.label));
            if (hit && !seen.has(hit.label)) {
                seen.add(hit.label);
                legend.push({
                    label: c.text.trim(),
                    fill: c.fill || hit.fill,
                    fontColor: c.color || '',
                    meaning: hit.meaning,
                });
            }
        }
    }
    if (!legend.length) return DEFAULT_LEGEND.map((l) => ({ ...l, fontColor: '' }));
    return legend;
}

function joinLeaveMessage(cells) {
    const joined = cells.map((c) => c.text).join('').replace(/[^A-Za-z]/g, '').toUpperCase();
    for (const p of LEAVE_PHRASES) {
        if (p.re.test(joined.replace(/LEAVE/, ' LEAVE').replace(/MATERNITY/, 'MATERNITY ').replace(/STUDY/, 'STUDY ').replace(/PART/, 'PART '))) {
            return p.type;
        }
        if (joined.includes(p.type.toUpperCase().replace(/ /g, '') + 'LEAVE') || joined.includes(p.type.toUpperCase().replace(/ /g, ''))) {
            if (joined.includes('LEAVE') || p.type === 'Maternity' || p.type === 'Study' || p.type === 'Part') {
                if (joined.includes(p.type.toUpperCase().replace(/ /g, ''))) return p.type;
            }
        }
    }
    if (joined.includes('MATERNITYLEAVE')) return 'Maternity';
    if (joined.includes('PARTLEAVE')) return 'Part';
    if (joined.includes('STUDYLEAVE')) return 'Study';
    if (joined.includes('ANNUALLEAVE')) return 'Annual';
    if (joined.includes('SICKLEAVE')) return 'Sick';
    return '';
}

/** Banner / totals rows that sit in the name column without a serial number. */
const NON_STAFF_NAME = /^(ROTATION|LYING\s*INN?|MORNING\s*DUTY|AFTERNOON\s*DUTY|NIGHT\s*DUTY|OFF\s*DUTY|SOD|DAY|RANK|NAME|WEEK|NO|TOTAL)$/i;
const SHIFTISH_NAME = /^(M|A|N|O|H|SOD|OFC|LV)$/i;
const RANKISH = /^(AMPS|SMO|MO|SSM|SM|SSN|SN|SNO|RM|RN|EN|MW|PNO|PMO|[A-Z]{2,6})$/i;

/**
 * Numbered rows (1, 2, …) always count. Unnumbered rows under ROTATION also count
 * when they have a person name + rank (e.g. Doris Ayensu / RM with blank NO).
 */
function isStaffRow(row) {
    const no = (row[0]?.text || '').trim();
    const name = (row[1]?.text || '').trim();
    const rank = (row[2]?.text || '').trim();
    if (!/[A-Za-z]{2,}/.test(name)) return false;
    if (NON_STAFF_NAME.test(name) || SHIFTISH_NAME.test(name)) return false;
    if (/DUTY|WEEK|TOTAL|LEAVE/i.test(name) && !/\s/.test(name)) return false;
    const hasNo = /^\d+$/.test(no);
    if (hasNo) return true;
    // Rotation / seconded block: blank NO, name + short rank abbr
    return Boolean(rank && RANKISH.test(rank) && /[A-Za-z]{2,}/.test(name));
}

function isRotationBanner(row) {
    const name = (row[1]?.text || '').trim();
    const joined = row.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
    return /^ROTATION$/i.test(name) || /^ROTATION$/i.test(joined);
}

function isLyingInBanner(row) {
    const name = (row[1]?.text || '').trim();
    const joined = row.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
    return /LYING\s*INN?/i.test(name) || /LYING\s*INN?/i.test(joined);
}

/**
 * Parse a Ghana-style duty-roster .docx into a compact coloured grid.
 */
export async function parseDocxRoster(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('word/document.xml')?.async('string');
    if (!xml) throw new Error('Not a valid Word document');

    const tblMatch = xml.match(/<w:tbl[\s>][\s\S]*<\/w:tbl>/);
    if (!tblMatch) throw new Error('No table found in the roster');

    const preamble = extractParagraphText(xml.split('<w:tbl')[0] || '');
    const rows = cellsFromTableXml(tblMatch[0]);
    const titleInfo = parseTitle(preamble || rows[0]?.map((c) => c.text).join(' ') || '');

    const dateRow = findDateRow(rows) || [];
    const dayRow = findDayRow(rows) || [];
    const dateStart = dateRow.findIndex((c) => /^\d{1,2}$/.test(c.text));
    const dayNums = dateStart >= 0 ? dateRow.slice(dateStart).map((c) => c.text) : [];

    const days = [];
    let monthIndex = MONTHS[String(titleInfo.month || '').toUpperCase()];
    let year = titleInfo.year;
    let prevDay = 0;
    for (let i = 0; i < dayNums.length; i++) {
        const n = Number(dayNums[i]);
        if (!Number.isFinite(n)) continue;
        if (monthIndex == null || !year) {
            days.push({ date: '', dayNum: n, dow: '', weekend: false });
            continue;
        }
        if (prevDay && n < prevDay) {
            monthIndex += 1;
            if (monthIndex > 11) {
                monthIndex = 0;
                year += 1;
            }
        }
        prevDay = n;
        const d = new Date(Date.UTC(year, monthIndex, n));
        const dowCell = dayRow[dateStart + i];
        days.push({
            date: d.toISOString().slice(0, 10),
            dayNum: n,
            dow: dowCell?.text || '',
            weekend: WEEKEND_FILLS.has((dateRow[dateStart + i]?.fill || '').toUpperCase()),
        });
    }

    const legend = detectLegend(rows);
    const staffRows = [];
    let inRotation = false;

    for (const row of rows) {
        if (isRotationBanner(row)) {
            inRotation = true;
            continue;
        }
        if (isLyingInBanner(row)) {
            inRotation = false;
            continue;
        }
        if (!isStaffRow(row)) continue;
        // Numbered main / lying-in rows leave the rotation block
        if (/^\d+$/.test((row[0]?.text || '').trim())) inRotation = false;

        const dutyCells = row.slice(3);
        const leaveType = joinLeaveMessage(dutyCells) || (STUDY_FILLS.has((row[1]?.fill || '').toUpperCase()) ? 'Study' : '');
        const cells = dutyCells.map((c, idx) => {
            const day = days[idx];
            return {
                text: c.text,
                fill: c.fill,
                fontColor: c.color,
                date: day?.date || '',
                sod: SOD_FILLS.has(c.fill),
                leaveFill: LEAVE_FILLS.has(c.fill),
            };
        });
        staffRows.push({
            no: (row[0]?.text || '').trim(),
            name: row[1].text,
            rank: row[2]?.text || '',
            cells,
            leaveType,
            isRotation: inRotation,
        });
    }

    return {
        title: titleInfo.title,
        unit: titleInfo.unit,
        month: titleInfo.month,
        year: titleInfo.year,
        days,
        legend,
        rows: staffRows,
    };
}

export { WEEKEND_FILLS, SOD_FILLS, DEFAULT_LEGEND };
