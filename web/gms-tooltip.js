// Accessible, responsive hint/toggletip helper built on the Popover API and
// interestfor semantics, with progressive fallbacks for browsers without native
// interest invokers, popover="hint", or implicit CSS anchor positioning.
(function () {
  let seq = 0;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch];
    });
  }

  function nextTipId(prefix) {
    seq += 1;
    return (prefix || 'gms-tip') + '-' + seq;
  }

  function renderInfoTip(options) {
    const id = nextTipId(options && options.idPrefix);
    const ariaLabel = escapeHtml((options && options.ariaLabel) || 'More information');
    const rows = Array.isArray(options && options.rows) ? options.rows : [];
    const rowsHtml = rows.map(function (row) {
      return (
        '<div class="gms-tooltip-row">' +
          '<span class="gms-tooltip-label">' + escapeHtml(row.label) + ':</span> ' +
          '<span class="gms-tooltip-value">' + escapeHtml(row.value) + '</span>' +
        '</div>'
      );
    }).join('');

    return (
      '<button type="button" class="info-tooltip-btn" ' +
        'interestfor="' + id + '" ' +
        'popovertarget="' + id + '" ' +
        'popovertargetaction="show" ' +
        'aria-label="' + ariaLabel + '">' +
        '<i class="fa-solid fa-circle-info added-by-icon" aria-hidden="true"></i>' +
      '</button>' +
      '<div id="' + id + '" popover="hint" role="tooltip" class="gms-tooltip">' +
        rowsHtml +
      '</div>'
    );
  }

  const supportsPopover = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');
  const supportsInterest = typeof HTMLButtonElement !== 'undefined' && ('interestForElement' in HTMLButtonElement.prototype);
  const supportsAnchorArea = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('position-area: block-start');
  const useNativeImplicitAnchor = supportsInterest && supportsAnchorArea;

  let supportsHintPopover = false;
  if (supportsPopover && typeof document !== 'undefined') {
    const probe = document.createElement('div');
    probe.setAttribute('popover', 'hint');
    supportsHintPopover = probe.popover === 'hint';
  }

  function isTipOpen(tip) {
    if (!tip) return false;
    if (supportsPopover) {
      try { return tip.matches(':popover-open'); } catch (_) { /* ignore */ }
    }
    return tip.classList.contains('gms-tooltip-open');
  }

  function findTriggersFor(tipId) {
    if (!tipId || typeof document === 'undefined') return [];
    const escId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(tipId) : tipId;
    return Array.from(document.querySelectorAll('[interestfor="' + escId + '"], [popovertarget="' + escId + '"]'));
  }

  function positionTipRelativeToTrigger(tip, trigger) {
    if (!tip || !trigger || useNativeImplicitAnchor) return;
    tip.classList.add('gms-tooltip--js-pos');
    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const vh = window.innerHeight || document.documentElement.clientHeight || 768;
    const estimatedWidth = tip.offsetWidth || 230;
    const estimatedHeight = tip.offsetHeight || 68;
    const gap = 8;

    let top = rect.top - estimatedHeight - gap;
    if (top < 8) {
      top = Math.min(vh - estimatedHeight - 8, rect.bottom + gap);
    }
    let left = rect.left + rect.width / 2 - estimatedWidth / 2;
    left = Math.max(8, Math.min(vw - estimatedWidth - 8, left));

    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(Math.max(8, top)) + 'px';
  }

  function showTip(trigger, tip) {
    if (!tip) return;
    document.querySelectorAll('.gms-tooltip').forEach(function (other) {
      if (other !== tip && isTipOpen(other)) hideTip(other);
    });
    if (supportsPopover) {
      if (!supportsHintPopover && tip.getAttribute('popover') === 'hint') {
        tip.setAttribute('popover', 'auto');
      }
      if (!isTipOpen(tip)) {
        try { tip.showPopover(); } catch (_) { tip.classList.add('gms-tooltip-open'); }
      }
      positionTipRelativeToTrigger(tip, trigger);
    } else {
      tip.classList.add('gms-tooltip-open');
      positionTipRelativeToTrigger(tip, trigger);
      syncExpandedState(tip.id, true);
    }
  }

  function hideTip(tip) {
    if (!tip || !isTipOpen(tip)) return;
    if (supportsPopover) {
      try { tip.hidePopover(); } catch (_) { tip.classList.remove('gms-tooltip-open'); }
    } else {
      tip.classList.remove('gms-tooltip-open');
      syncExpandedState(tip.id, false);
    }
  }

  function syncExpandedState(tipId, open) {
    findTriggersFor(tipId).forEach(function (btn) {
      if (btn.hasAttribute('popovertarget') || btn.hasAttribute('commandfor')) {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    });
  }

  let globalBound = false;
  function bindGlobalListeners() {
    if (globalBound || typeof document === 'undefined') return;
    globalBound = true;

    if (!supportsHintPopover && supportsPopover) {
      document.addEventListener('beforetoggle', function (e) {
        const target = e.target;
        if (!target || target.getAttribute('popover') !== 'hint') return;
        const hasInvoker = target.id && document.querySelector('[popovertarget="' + CSS.escape(target.id) + '"]');
        if (e.newState === 'open' && hasInvoker) {
          target.setAttribute('popover', 'auto');
        }
      }, true);
    }

    document.addEventListener('beforetoggle', function (e) {
      const target = e.target;
      if (!target || !target.classList || !target.classList.contains('gms-tooltip')) return;
      if (e.newState === 'open') {
        const trigger = findTriggersFor(target.id)[0];
        if (trigger) {
          requestAnimationFrame(function () {
            positionTipRelativeToTrigger(target, trigger);
          });
        }
      }
    }, true);

    document.addEventListener('toggle', function (e) {
      const target = e.target;
      if (!target || !target.id || !target.classList || !target.classList.contains('gms-tooltip')) return;
      syncExpandedState(target.id, e.newState === 'open');
    }, true);

    if (!supportsPopover) {
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          document.querySelectorAll('.gms-tooltip.gms-tooltip-open').forEach(hideTip);
        }
      });
      document.addEventListener('click', function (e) {
        document.querySelectorAll('.gms-tooltip.gms-tooltip-open').forEach(function (tip) {
          if (tip.contains(e.target)) return;
          const relatedTriggers = findTriggersFor(tip.id);
          if (relatedTriggers.some(function (t) { return t === e.target || t.contains(e.target); })) return;
          hideTip(tip);
        });
      });
    }
  }

  function wire(root) {
    bindGlobalListeners();
    const scope = root || document;
    const triggers = scope.querySelectorAll('.info-tooltip-btn[interestfor]');
    triggers.forEach(function (btn) {
      const tipId = btn.getAttribute('interestfor');
      const tip = tipId ? document.getElementById(tipId) : null;
      if (!tip) return;

      if (!tip.hasAttribute('role')) tip.setAttribute('role', 'tooltip');
      if (btn.hasAttribute('popovertarget') || btn.hasAttribute('commandfor')) {
        btn.setAttribute('aria-expanded', isTipOpen(tip) ? 'true' : 'false');
      }

      if (btn.dataset.gmsTipBound === '1') return;
      btn.dataset.gmsTipBound = '1';

      if (!supportsInterest) {
        let hideTimer = null;
        const scheduleHide = function () {
          clearTimeout(hideTimer);
          hideTimer = setTimeout(function () {
            if (!btn.matches(':hover') && !tip.matches(':hover') && document.activeElement !== btn && !tip.contains(document.activeElement)) {
              hideTip(tip);
            }
          }, 140);
        };
        const cancelAndShow = function () {
          clearTimeout(hideTimer);
          showTip(btn, tip);
        };

        const onPointerEnter = function (e) {
          if (e.pointerType === 'touch') return;
          cancelAndShow();
        };
        const onPointerLeave = function (e) {
          if (e.pointerType === 'touch') return;
          scheduleHide();
        };

        btn.addEventListener('pointerenter', onPointerEnter);
        btn.addEventListener('pointerleave', onPointerLeave);
        tip.addEventListener('pointerenter', onPointerEnter);
        tip.addEventListener('pointerleave', onPointerLeave);

        btn.addEventListener('focusin', cancelAndShow);
        btn.addEventListener('focusout', function (e) {
          if (!tip.contains(e.relatedTarget) && e.relatedTarget !== btn) {
            hideTip(tip);
          }
        });

        if (!supportsPopover) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (isTipOpen(tip)) hideTip(tip);
            else cancelAndShow();
          });
        }
      }
    });
  }

  window.GMSTooltip = {
    escapeHtml: escapeHtml,
    renderInfoTip: renderInfoTip,
    wire: wire,
  };
})();
