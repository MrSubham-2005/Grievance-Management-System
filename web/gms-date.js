'use strict';

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.GMSDate = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this, function () {
    const DOMAIN_SENTINELS = {
        pending: 'Pending',
        'not available': 'Not Available'
    };

    const REJECTED_LITERALS = {
        'invalid date': true,
        'nan': true,
        'null': true,
        'undefined': true,
        'n/a': true,
        'na': true,
        '-': true,
        '--': true
    };

    function pad2(num) {
        return String(num).padStart(2, '0');
    }

    function pad4(num) {
        return String(num).padStart(4, '0');
    }

    function isValidCalendarDate(year, month, day) {
        if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
            return false;
        }
        if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) {
            return false;
        }
        if (typeof Temporal !== 'undefined' && typeof Temporal.PlainDate === 'function') {
            try {
                Temporal.PlainDate.from({ year: year, month: month, day: day }, { overflow: 'reject' });
                return true;
            } catch (_err) {
                return false;
            }
        }
        const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        const maxDays = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        return day <= maxDays[month - 1];
    }

    function formatDMY(day, month, year) {
        return pad2(day) + '-' + pad2(month) + '-' + pad4(year);
    }

    function buildParsedCalendar(day, month, year, rawTime) {
        const timePart = rawTime ? rawTime.trim() : '';
        if (timePart && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timePart)) {
            return null;
        }
        if (!isValidCalendarDate(year, month, day)) {
            return { invalid: true };
        }
        return {
            day: day,
            month: month,
            year: year,
            timePart: timePart
        };
    }

    function parseCalendarPrefix(text) {
        // Year-first: YYYY-MM-DD or YYYY/MM/DD (with optional local time after space/comma)
        let match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[,\s]+(.+))?$/.exec(text);
        if (match) {
            return buildParsedCalendar(Number(match[3]), Number(match[2]), Number(match[1]), match[4]);
        }

        // Day-first: D/M/YYYY, DD/MM/YYYY, D-M-YYYY, DD-MM-YYYY (with optional local time)
        match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[,\s]+(.+))?$/.exec(text);
        if (match) {
            return buildParsedCalendar(Number(match[1]), Number(match[2]), Number(match[3]), match[4]);
        }

        return null;
    }

    function resolveSentinel(value, fallback) {
        const fb = fallback === undefined ? '' : fallback;
        if (value === null || value === undefined) {
            return { done: true, result: fb };
        }
        if (value instanceof Date) {
            return { done: false };
        }
        if (typeof value !== 'string') {
            return { done: true, result: fb };
        }
        const trimmed = value.trim();
        if (!trimmed) {
            return { done: true, result: fb };
        }
        const lower = trimmed.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(DOMAIN_SENTINELS, lower)) {
            return { done: true, result: DOMAIN_SENTINELS[lower] };
        }
        if (Object.prototype.hasOwnProperty.call(REJECTED_LITERALS, lower)) {
            return { done: true, result: fb };
        }
        return { done: false, text: trimmed };
    }

    function formatInstant(dt, includeTime, fallback) {
        if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) {
            return fallback;
        }
        const dateStr = formatDMY(dt.getDate(), dt.getMonth() + 1, dt.getFullYear());
        if (!includeTime) {
            return dateStr;
        }
        const timeStr = dt.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
        return dateStr + ', ' + timeStr;
    }

    function formatDate(value, fallback) {
        const fb = fallback === undefined ? '' : fallback;
        const resolved = resolveSentinel(value, fb);
        if (resolved.done) {
            return resolved.result;
        }
        if (value instanceof Date) {
            return formatInstant(value, false, fb);
        }
        const parsed = parseCalendarPrefix(resolved.text);
        if (parsed) {
            return parsed.invalid ? fb : formatDMY(parsed.day, parsed.month, parsed.year);
        }
        return formatInstant(new Date(resolved.text), false, fb);
    }

    function formatDateTime(value, fallback) {
        const fb = fallback === undefined ? '' : fallback;
        const resolved = resolveSentinel(value, fb);
        if (resolved.done) {
            return resolved.result;
        }
        if (value instanceof Date) {
            return formatInstant(value, true, fb);
        }
        const parsed = parseCalendarPrefix(resolved.text);
        if (parsed) {
            if (parsed.invalid) {
                return fb;
            }
            const formattedDate = formatDMY(parsed.day, parsed.month, parsed.year);
            return parsed.timePart ? formattedDate + ', ' + parsed.timePart : formattedDate;
        }
        return formatInstant(new Date(resolved.text), true, fb);
    }

    return {
        formatDate: formatDate,
        formatDateTime: formatDateTime
    };
});
