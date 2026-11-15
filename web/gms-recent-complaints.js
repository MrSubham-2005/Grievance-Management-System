// Shared Recent Complaints table renderer for Student, Staff, and Admin dashboards.
// Keeps the 8 standardized columns, priority/status badges, and description tooltip consistent.
(function () {
  'use strict';

  function statusBadgeClass(status) {
    switch (String(status || '').trim().toLowerCase()) {
      case 'pending':
        return 'badge-pending';
      case 'assigned':
        return 'badge-assigned';
      case 'in progress':
        return 'badge-in-progress';
      case 'resolved':
        return 'badge-resolved';
      default:
        return '';
    }
  }

  function priorityBadgeClass(priority) {
    switch (String(priority || '').trim().toLowerCase()) {
      case 'high':
        return 'badge-priority-high';
      case 'low':
        return 'badge-priority-low';
      case 'medium':
      default:
        return 'badge-priority-medium';
    }
  }

  const MAX_PREVIEW_CHARS = 55;
  const tbodyState = new WeakMap();
  const trackedBodies = new Set();
  let fontsHookBound = false;

  function normalizeDescription(description) {
    const full = String(description || '').trim();
    if (!full) {
      return { full: '', preview: '', charTruncated: false };
    }
    const singleLine = full.replace(/\s+/g, ' ');
    const charTruncated = singleLine.length > MAX_PREVIEW_CHARS;
    const preview = charTruncated
      ? singleLine.slice(0, MAX_PREVIEW_CHARS).trimEnd() + '...'
      : singleLine;
    return {
      full: full,
      preview: preview,
      charTruncated: charTruncated,
    };
  }

  function buildTipHtml(complaintId, full) {
    if (!window.GMSTooltip || typeof window.GMSTooltip.renderInfoTip !== 'function') {
      return '';
    }
    return window.GMSTooltip.renderInfoTip({
      idPrefix: 'recent-desc-tip',
      ariaLabel: 'Full description for ' + (complaintId || 'complaint'),
      rows: [{ label: 'Description', value: full }],
    });
  }

  function formatDescriptionCell(complaintId, meta, esc) {
    const tipHtml = meta.charTruncated ? buildTipHtml(complaintId, meta.full) : '';
    return (
      '<span class="complaint-desc-cell">' +
        '<span class="complaint-desc-preview">' + esc(meta.preview) + '</span>' +
        tipHtml +
      '</span>'
    );
  }

  function isTextClipped(previewEl) {
    if (!previewEl || typeof previewEl.clientWidth !== 'number' || previewEl.clientWidth <= 0) {
      return false;
    }
    if (previewEl.scrollWidth > previewEl.clientWidth) {
      return true;
    }
    if (
      typeof window !== 'undefined' &&
      typeof window.getComputedStyle === 'function' &&
      typeof document !== 'undefined' &&
      typeof document.createRange === 'function' &&
      typeof previewEl.getBoundingClientRect === 'function' &&
      previewEl.firstChild
    ) {
      const boxRect = previewEl.getBoundingClientRect();
      const maxWidth = parseFloat(window.getComputedStyle(previewEl).maxWidth);
      const cellEl = previewEl.parentElement;
      const cellMaxWidth = cellEl ? parseFloat(window.getComputedStyle(cellEl).maxWidth) : NaN;
      const constrained =
        (Number.isFinite(maxWidth) && maxWidth > 0 && boxRect.width >= maxWidth - 1.5) ||
        (cellEl &&
          typeof cellEl.getBoundingClientRect === 'function' &&
          Number.isFinite(cellMaxWidth) &&
          cellMaxWidth > 0 &&
          cellEl.getBoundingClientRect().width >= cellMaxWidth - 1.5);
      if (constrained) {
        const range = document.createRange();
        range.selectNodeContents(previewEl);
        if (range.getBoundingClientRect().width - boxRect.width > 0.25) {
          return true;
        }
      }
    }
    return false;
  }

  function appendTipToCell(cellEl, meta) {
    const tipHtml = buildTipHtml(meta.complaintId, meta.full);
    if (!tipHtml || typeof document === 'undefined') return;
    if (typeof document.createElement === 'function') {
      const tpl = document.createElement('template');
      if ('content' in tpl && tpl.content) {
        tpl.innerHTML = tipHtml;
        cellEl.appendChild(tpl.content);
      } else {
        const box = document.createElement('span');
        box.innerHTML = tipHtml;
        while (box.firstChild) {
          cellEl.appendChild(box.firstChild);
        }
      }
    }
    if (window.GMSTooltip && typeof window.GMSTooltip.wire === 'function') {
      window.GMSTooltip.wire(cellEl);
    }
  }

  function removeTipFromCell(cellEl) {
    const btn = cellEl.querySelector('.info-tooltip-btn');
    const tip = cellEl.querySelector('.gms-tooltip');
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
  }

  function syncDescriptionTooltips(tbody) {
    const state = tbodyState.get(tbody);
    if (!state || !Array.isArray(state.items)) return;
    state.items.forEach(function (entry) {
      const cellEl = entry.cellEl;
      const meta = entry.meta;
      if (!cellEl || !meta || !meta.full) return;
      const previewEl = cellEl.querySelector('.complaint-desc-preview');
      const truncated = meta.charTruncated || isTextClipped(previewEl);
      const hasBtn = Boolean(cellEl.querySelector('.info-tooltip-btn'));
      if (truncated && !hasBtn) {
        appendTipToCell(cellEl, meta);
      } else if (!truncated && hasBtn && !meta.charTruncated) {
        removeTipFromCell(cellEl);
      }
    });
  }

  function bindFontAndResizeSync(tbody) {
    if (!fontsHookBound && typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      fontsHookBound = true;
      Promise.resolve(document.fonts.ready)
        .then(function () {
          trackedBodies.forEach(function (tb) {
            if (tb && tb.isConnected) {
              syncDescriptionTooltips(tb);
            } else {
              trackedBodies.delete(tb);
            }
          });
        })
        .catch(function () { /* ignore font readiness errors */ });
    }

    trackedBodies.add(tbody);
    const state = tbodyState.get(tbody);
    if (!state || state.resizeObserver || typeof ResizeObserver !== 'function') return;

    let rafId = 0;
    state.resizeObserver = new ResizeObserver(function () {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        if (rafId) window.cancelAnimationFrame(rafId);
        rafId = window.requestAnimationFrame(function () {
          rafId = 0;
          syncDescriptionTooltips(tbody);
        });
      } else {
        syncDescriptionTooltips(tbody);
      }
    });
    state.resizeObserver.observe(tbody);
  }

  function render(tbody, complaints) {
    if (!tbody) return;
    const esc = window.GMSTooltip
      ? window.GMSTooltip.escapeHtml
      : function (v) {
          return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
          });
        };

    if (!Array.isArray(complaints) || complaints.length === 0) {
      const prevState = tbodyState.get(tbody);
      if (prevState) prevState.items = [];
      tbody.innerHTML =
        '<tr>' +
          '<td colspan="8" style="text-align:center;">' +
            'No complaints found.' +
          '</td>' +
        '</tr>';
      return;
    }

    const visibleRows = complaints.slice(0, 5);
    const rowMetas = [];

    tbody.innerHTML = visibleRows.map(function (c) {
      const meta = normalizeDescription(c.description);
      meta.complaintId = c.complaintId;
      rowMetas.push(meta);

      const idText = esc(c.complaintId);
      const priorityText = esc(c.priority || 'Medium');
      const statusText = esc(c.status);
      return (
        '<tr>' +
          '<td>' + idText + '</td>' +
          '<td>' + esc(c.studentId) + '</td>' +
          '<td>' + esc(c.studentName) + '</td>' +
          '<td>' + esc(c.category) + '</td>' +
          '<td>' + formatDescriptionCell(c.complaintId, meta, esc) + '</td>' +
          '<td>' +
            '<span class="badge priority-badge ' + priorityBadgeClass(c.priority) + '">' +
              priorityText +
            '</span>' +
          '</td>' +
          '<td>' + esc(typeof GMSDate !== 'undefined' ? GMSDate.formatDate(c.date) : c.date) + '</td>' +
          '<td>' +
            '<span class="badge ' + statusBadgeClass(c.status) + '">' +
              statusText +
            '</span>' +
          '</td>' +
        '</tr>'
      );
    }).join('');

    if (typeof tbody.querySelectorAll === 'function') {
      const cells = Array.from(tbody.querySelectorAll('.complaint-desc-cell'));
      const existingState = tbodyState.get(tbody) || { resizeObserver: null };
      existingState.items = cells.map(function (cellEl, idx) {
        return { cellEl: cellEl, meta: rowMetas[idx] };
      });
      tbodyState.set(tbody, existingState);
      syncDescriptionTooltips(tbody);
      bindFontAndResizeSync(tbody);
    }

    if (window.GMSTooltip && typeof window.GMSTooltip.wire === 'function') {
      window.GMSTooltip.wire(tbody);
    }
  }

  // Coalesce concurrent refresh triggers so focus/visibility updates while a fetch
  // is in flight still trigger one immediate trailing refresh instead of dropping.
  function createRefreshRunner(loadFn) {
    let loading = false;
    let pending = false;

    function run() {
      if (loading) {
        pending = true;
        return;
      }
      loading = true;
      Promise.resolve()
        .then(loadFn)
        .catch(function () { /* callers handle and render fetch errors */ })
        .finally(function () {
          loading = false;
          if (pending) {
            pending = false;
            run();
          }
        });
    }

    return run;
  }

  window.GMSRecentComplaints = {
    render: render,
    syncDescriptionTooltips: syncDescriptionTooltips,
    statusBadgeClass: statusBadgeClass,
    priorityBadgeClass: priorityBadgeClass,
    createRefreshRunner: createRefreshRunner,
  };
})();
