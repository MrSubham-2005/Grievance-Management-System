const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function createMiniDom() {
  class MiniElement {
    constructor(tagName) {
      this.tagName = String(tagName || 'div').toUpperCase();
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
      this.parentElement = null;
      this.dataset = {};
      this.style = {};
      this.listeners = new Map();
      this._text = '';
      this.clientWidth = 0;
      this.scrollWidth = 0;
      this.isConnected = true;
      this.classList = {
        add: (...names) => {
          const cur = new Set((this.getAttribute('class') || '').split(/\s+/).filter(Boolean));
          names.forEach((n) => cur.add(n));
          this.setAttribute('class', Array.from(cur).join(' '));
        },
        remove: (...names) => {
          const cur = new Set((this.getAttribute('class') || '').split(/\s+/).filter(Boolean));
          names.forEach((n) => cur.delete(n));
          this.setAttribute('class', Array.from(cur).join(' '));
        },
        contains: (name) => (this.getAttribute('class') || '').split(/\s+/).filter(Boolean).includes(name),
      };
    }

    get firstChild() {
      return this.children[0] || null;
    }

    get id() {
      return this.getAttribute('id') || '';
    }

    setAttribute(k, v) {
      this.attributes.set(String(k), String(v));
    }

    getAttribute(k) {
      const val = this.attributes.get(String(k));
      return val === undefined ? null : val;
    }

    hasAttribute(k) {
      return this.attributes.has(String(k));
    }

    appendChild(child) {
      if (!child) return child;
      if (child._isFragment) {
        const list = child.children.slice();
        list.forEach((c) => this.appendChild(c));
        return child;
      }
      child.parentNode = this;
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentNode = null;
        child.parentElement = null;
      }
      return child;
    }

    matches(selector) {
      if (selector === ':hover') return false;
      if (selector.startsWith('.')) {
        return this.classList.contains(selector.slice(1));
      }
      const attrMatch = /^\[([a-z0-9-]+)="([^"]*)"\]$/i.exec(selector);
      if (attrMatch) {
        return this.getAttribute(attrMatch[1]) === attrMatch[2];
      }
      return false;
    }

    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }

    dispatchEvent(evt) {
      const e = Object.assign({ stopPropagation() {}, target: this }, evt);
      for (const fn of this.listeners.get(e.type) || []) {
        fn(e);
      }
    }

    getBoundingClientRect() {
      return { left: 40, top: 200, right: 64, bottom: 224, width: this.clientWidth || 24, height: 24 };
    }

    querySelectorAll(selector) {
      const out = [];
      const selectors = selector.split(',').map((s) => s.trim());
      const visit = (node) => {
        for (const child of node.children) {
          if (child._isText) continue;
          if (selectors.some((sel) => matchesSelector(child, sel))) {
            out.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return out;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    set innerHTML(html) {
      this.children = [];
      parseInto(html, this);
    }

    get innerHTML() {
      return serializeChildren(this);
    }

    get textContent() {
      if (this._text) return this._text;
      return this.children.map((c) => c.textContent).join('');
    }
  }

  function matchesSelector(el, sel) {
    if (sel === '.gms-tooltip.gms-tooltip-open') {
      return el.classList.contains('gms-tooltip') && el.classList.contains('gms-tooltip-open');
    }
    if (sel === '.info-tooltip-btn[interestfor]') {
      return el.classList.contains('info-tooltip-btn') && el.hasAttribute('interestfor');
    }
    return el.matches(sel);
  }

  function decodeEntities(s) {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function serializeChildren(node) {
    return node.children
      .map((c) => {
        if (c._isText) return c._text;
        const attrs = Array.from(c.attributes.entries())
          .map(([k, v]) => ` ${k}="${v}"`)
          .join('');
        return `<${c.tagName.toLowerCase()}${attrs}>${serializeChildren(c)}</${c.tagName.toLowerCase()}>`;
      })
      .join('');
  }

  function parseInto(html, rootEl) {
    const stack = [rootEl];
    const tokenRe = /<(\/?)([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
    let m;
    while ((m = tokenRe.exec(String(html || '')))) {
      if (m[4]) {
        const textNode = { _isText: true, _text: decodeEntities(m[4]), textContent: decodeEntities(m[4]), children: [] };
        stack[stack.length - 1].appendChild(textNode);
      } else if (m[1]) {
        if (stack.length > 1) stack.pop();
      } else {
        const el = new MiniElement(m[2]);
        const attrRe = /([a-zA-Z0-9-]+)="([^"]*)"/g;
        let am;
        while ((am = attrRe.exec(m[3] || ''))) {
          el.setAttribute(am[1], decodeEntities(am[2]));
        }
        stack[stack.length - 1].appendChild(el);
        stack.push(el);
      }
    }
  }

  const body = new MiniElement('body');
  const tbody = new MiniElement('tbody');
  tbody.setAttribute('id', 'recentComplaintsBody');
  body.appendChild(tbody);

  const docListeners = new Map();
  const doc = {
    documentElement: { clientWidth: 1280, clientHeight: 800 },
    activeElement: null,
    createElement(tag) {
      if (tag === 'template') {
        const frag = new MiniElement('fragment');
        frag._isFragment = true;
        return {
          content: frag,
          set innerHTML(v) {
            frag.innerHTML = v;
          },
        };
      }
      return new MiniElement(tag);
    },
    getElementById(id) {
      return body.querySelector(`[id="${id}"]`);
    },
    querySelectorAll(sel) {
      return body.querySelectorAll(sel);
    },
    querySelector(sel) {
      return body.querySelector(sel);
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    dispatchEvent(evt) {
      const e = Object.assign({ target: body }, evt);
      for (const fn of docListeners.get(e.type) || []) {
        fn(e);
      }
    },
  };

  const fakeWindow = {
    location: { pathname: '/HTML/ADMIN/admin_dashboard.html' },
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    setTimeout,
    clearTimeout,
  };
  fakeWindow.window = fakeWindow;
  fakeWindow.globalThis = fakeWindow;

  const ctx = vm.createContext(fakeWindow);
  ctx.HTMLElement = function () {};
  ctx.HTMLButtonElement = function () {};
  ctx.CSS = { escape: (s) => s };

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'gms-date.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'gms-tooltip.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'gms-recent-complaints.js'), 'utf8'), ctx);

  return { ctx, doc, tbody, body };
}

test('GMSRecentComplaints shows tooltip for CSS-clipped medium and long descriptions, omits for fitting short ones, and updates on width changes', () => {
  const { ctx, doc, tbody } = createMiniDom();

  const complaints = [
    {
      complaintId: 'CMP-0010',
      studentId: 'STU-0001',
      studentName: 'Asha Rao',
      category: 'IT',
      description: 'Wi-Fi slow',
      priority: 'Low',
      date: '2026-11-12',
      status: 'Pending',
    },
    {
      complaintId: 'CMP-0011',
      studentId: 'STU-0002',
      studentName: 'Ravi Verma',
      category: 'Hostel',
      description: 'Street lights flickering near Block B.',
      priority: 'Medium',
      date: '2026-11-12',
      status: 'Assigned',
    },
    {
      complaintId: 'CMP-0012',
      studentId: 'STU-0003',
      studentName: 'Neha Das',
      category: 'Network',
      description: 'Unbrokenidentifierexceedingtwentypixelswidth',
      priority: 'High',
      date: '2026-11-12',
      status: 'Pending',
    },
    {
      complaintId: 'CMP-0013',
      studentId: 'STU-0004',
      studentName: 'Kiran Sen',
      category: 'Library',
      description: 'The reading hall air conditioning unit stopped working during afternoon study hours.',
      priority: 'High',
      date: '2026-11-12',
      status: 'In Progress',
    },
  ];

  ctx.GMSRecentComplaints.render(tbody, complaints);

  const cells = tbody.querySelectorAll('.complaint-desc-cell');
  assert.equal(cells.length, 4);

  // Simulate CSS max-width: 220px layout widths
  const previews = cells.map((c) => c.querySelector('.complaint-desc-preview'));
  previews[0].clientWidth = 72;
  previews[0].scrollWidth = 72; // short fits completely
  previews[1].clientWidth = 220;
  previews[1].scrollWidth = 264; // medium <= 55 chars but CSS-clipped!
  previews[2].clientWidth = 220;
  previews[2].scrollWidth = 340; // single long word <= 55 chars CSS-clipped!
  previews[3].clientWidth = 220;
  previews[3].scrollWidth = 360; // > 55 chars

  ctx.GMSRecentComplaints.syncDescriptionTooltips(tbody);

  assert.equal(cells[0].querySelector('.info-tooltip-btn'), null, 'Short fitting text must not render info icon');
  assert.ok(cells[1].querySelector('.info-tooltip-btn'), 'CSS-clipped medium description must render info icon');
  assert.match(cells[1].querySelector('.gms-tooltip').textContent, /Street lights flickering near Block B\./);

  assert.ok(cells[2].querySelector('.info-tooltip-btn'), 'CSS-clipped single long word must render info icon');
  assert.match(cells[2].querySelector('.gms-tooltip').textContent, /Unbrokenidentifierexceedingtwentypixelswidth/);

  assert.ok(cells[3].querySelector('.info-tooltip-btn'), 'Long >55 char description must render info icon');
  assert.ok(previews[3].textContent.endsWith('...'));
  assert.match(cells[3].querySelector('.gms-tooltip').textContent, /stopped working during afternoon study hours\./);

  // Simulate keyboard focus, touch click, and outside click dismiss on CMP-0011 tooltip
  const tipBtn = cells[1].querySelector('.info-tooltip-btn');
  const tipEl = cells[1].querySelector('.gms-tooltip');
  doc.activeElement = tipBtn;
  tipBtn.dispatchEvent({ type: 'focusin' });
  assert.equal(tipEl.classList.contains('gms-tooltip-open'), true);
  assert.equal(tipBtn.getAttribute('aria-expanded'), 'true');

  // Touch pointerenter should not pre-open or fight touch click fallback
  tipBtn.dispatchEvent({ type: 'focusout', relatedTarget: null });
  assert.equal(tipEl.classList.contains('gms-tooltip-open'), false);
  tipBtn.dispatchEvent({ type: 'pointerenter', pointerType: 'touch' });
  assert.equal(tipEl.classList.contains('gms-tooltip-open'), false);
  tipBtn.dispatchEvent({ type: 'click', pointerType: 'touch' });
  assert.equal(tipEl.classList.contains('gms-tooltip-open'), true);

  // Clicking outside dismisses open tooltip
  doc.dispatchEvent({ type: 'click', target: tbody });
  assert.equal(tipEl.classList.contains('gms-tooltip-open'), false);

  // Simulate wider column where medium string now fits cleanly -> optional icon removed
  previews[1].clientWidth = 280;
  ctx.GMSRecentComplaints.syncDescriptionTooltips(tbody);
  assert.equal(cells[1].querySelector('.info-tooltip-btn'), null, 'When wider column fits text completely, optional icon is removed');
});

test('Recent complaints CSS configures flex ellipsis clipping and touch/focus tooltip button ergonomics', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web', 'CSS', 'style.css'), 'utf8');
  assert.match(css, /\.complaint-desc-cell\s*\{[^}]*display:\s*inline-flex;/);
  assert.match(css, /\.complaint-desc-cell\s+\.info-tooltip-btn\s*\{[^}]*flex-shrink:\s*0;/);
  assert.match(css, /\.complaint-desc-preview\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;/);
  assert.match(css, /\.info-tooltip-btn\s*\{[^}]*touch-action:\s*manipulation;/);
});
