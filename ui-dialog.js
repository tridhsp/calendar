/* ui-dialog.js — in-app replacements for the browser's alert() and confirm()      (6 Oct 2026)

   Loaded in the <head> of every page that used to call alert(), BEFORE the page's own scripts.
   It gives three functions:

     uiToast(message, kind, ms)    a small card at the bottom of the window. kind is one of
                                   ok | error | warn | info; it goes away by itself (4 s, errors
                                   7 s), stays while the mouse is over it, and has an x.
     uiAlert(message, options)     a dialog with one OK button. Returns a Promise that settles
                                   when it is closed. options: title, kind.
     uiConfirm(message, options)   a dialog with Cancel and OK. Returns a Promise<boolean>.
                                   options: title, okLabel, cancelLabel, danger (red OK button,
                                   and focus starts on Cancel so a stray Enter never deletes).

   AND IT REPLACES window.alert. Every alert(...) anywhere on the page — in any script, including
   the inline ones in offday.html — becomes a toast, or a dialog when the text is long or has
   several lines. The colour comes from the words in the message:
       "failed", "could not", "cannot", "error", "không thể"   -> red
       "please", "pick", "choose", "must", "vui lòng", "chọn"   -> amber
       "saved", "deleted", "updated", "done", "thành công"      -> green
       anything else                                            -> blue
   The browser's own alert is kept as window.nativeAlert.

   confirm() is NOT replaced here. A page cannot pause a running script the way the browser
   does, so a drop-in replacement is impossible; the five confirm() sites in teacher.js,
   teachercalendar-v2.js and teacherplanner.js were changed by hand to `await uiConfirm(...)`
   (every one already sat inside an async handler).

   Self-contained: it injects its own CSS (every class starts with uid-) and makes its
   containers on first use, so it works on a page without style.css. It uses Font Awesome for
   the icons, which every page here already loads. No library.                                */
(function () {
  'use strict';
  if (window.uiToast) return;                      // loaded twice: keep the first copy

  const KINDS = ['ok', 'error', 'warn', 'info'];
  const ICON = { ok: 'fa-circle-check', error: 'fa-circle-exclamation', warn: 'fa-triangle-exclamation', info: 'fa-circle-info' };
  const TITLE = { ok: 'Done', error: 'Something went wrong', warn: 'Check this first', info: 'Note' };

  const CSS = [
    '.uid-toasts{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:100050;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:min(560px,94vw)}',
    '.uid-toast{pointer-events:auto;box-sizing:border-box;max-width:100%;display:flex;align-items:flex-start;gap:10px;padding:11px 12px 11px 14px;border-radius:12px;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13.5px;font-weight:600;line-height:1.45;color:#0f172a;background:#fff;border:1px solid #e5e7eb;box-shadow:0 12px 30px rgba(16,24,40,.16);opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease}',
    '.uid-toast.on{opacity:1;transform:translateY(0)}',
    '.uid-toast > i{flex:none;font-size:16px;margin-top:1px}',
    '.uid-toast-text{flex:1;min-width:0;white-space:pre-line;overflow-wrap:anywhere}',
    '.uid-toast-x{flex:none;border:0;background:none;font:inherit;font-size:18px;line-height:1;color:inherit;opacity:.55;cursor:pointer;padding:0 2px;margin:-2px -2px 0 0}',
    '.uid-toast-x:hover{opacity:1}',
    '.uid-toast.uid-ok{border-color:#bbf7d0;background:#f0fdf4;color:#14532d}',
    '.uid-toast.uid-error{border-color:#fecaca;background:#fef2f2;color:#7f1d1d}',
    '.uid-toast.uid-warn{border-color:#fde68a;background:#fffbeb;color:#78350f}',
    '.uid-toast.uid-info{border-color:#bfdbfe;background:#eff6ff;color:#1e3a8a}',
    '.uid-overlay{position:fixed;inset:0;background:rgba(0,0,0,0);display:flex;align-items:center;justify-content:center;z-index:100040;transition:background .2s ease;padding:20px;box-sizing:border-box}',
    '.uid-overlay.on{background:rgba(0,0,0,.45)}',
    '.uid-pop{background:#fff;border-radius:20px;padding:28px 24px 20px;max-width:400px;width:100%;box-shadow:0 24px 48px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.04);text-align:center;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;transform:scale(.92) translateY(12px);opacity:0;transition:transform .25s cubic-bezier(.16,1,.3,1),opacity .2s ease}',
    '.uid-overlay.on .uid-pop{transform:scale(1) translateY(0);opacity:1}',
    '.uid-icon{width:56px;height:56px;border-radius:16px;display:inline-grid;place-items:center;font-size:22px;margin-bottom:14px}',
    '.uid-icon.uid-ok{background:#ecfdf3;color:#067647}',
    '.uid-icon.uid-error{background:#fef2f2;color:#dc2626}',
    '.uid-icon.uid-warn{background:#fffaeb;color:#b54708}',
    '.uid-icon.uid-info{background:#eff6ff;color:#2563eb}',
    '.uid-title{margin:0 0 8px;font-size:17px;font-weight:700;color:#1f2937}',
    '.uid-msg{margin:0 0 20px;font-size:13.5px;line-height:1.55;color:#4b5563;white-space:pre-line;overflow-wrap:anywhere;text-align:left}',
    '.uid-msg.uid-short{text-align:center}',
    '.uid-actions{display:flex;gap:10px;justify-content:center}',
    '.uid-btn{padding:10px 20px;border-radius:10px;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;border:none;min-width:96px;transition:background .15s,box-shadow .15s,transform .1s}',
    '.uid-btn:active{transform:scale(.97)}',
    '.uid-btn:focus-visible{outline:3px solid rgba(13,110,253,.45);outline-offset:2px}',
    '.uid-btn-cancel{background:#f3f4f6;color:#374151;border:1px solid #e5e7eb}',
    '.uid-btn-cancel:hover{background:#e5e7eb}',
    '.uid-btn-ok{background:#0d6efd;color:#fff;box-shadow:0 2px 8px rgba(13,110,253,.3)}',
    '.uid-btn-ok:hover{background:#0b5ed7}',
    '.uid-btn-ok.uid-btn-danger{background:#ef4444;box-shadow:0 2px 8px rgba(239,68,68,.3)}',
    '.uid-btn-ok.uid-btn-danger:hover{background:#dc2626}',
    '@media (prefers-reduced-motion: reduce){.uid-toast,.uid-pop,.uid-overlay{transition:none}}'
  ].join('\n');

  function ensureCss() {
    if (document.getElementById('uidStyles')) return;
    const s = document.createElement('style'); s.id = 'uidStyles'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* which colour a message gets. Order matters: a message that mentions a failure is red
     even if it also says "saved" ("Save failed"). */
  function uiKindOf(text) {
    const s = String(text == null ? '' : text).toLowerCase();
    if (/(fail|could not|couldn't|cannot|can't|unable|error|invalid|not ready|lỗi|không thể|thất bại)/.test(s)) return 'error';
    if (/(saved|updated|deleted|removed|added|complete|done|success|thành công|đã lưu|đã xóa|đã xoá|đã cập nhật)/.test(s)) return 'ok';
    if (/(please|pick |choose|select|must|required|at least|missing|again|first|vui lòng|hãy |chọn)/.test(s)) return 'warn';
    return 'info';
  }

  function uiToast(message, kind, ms) {
    ensureCss();
    if (!document.body) return;                    // called before the page has a body: nothing to attach to
    kind = KINDS.indexOf(kind) >= 0 ? kind : 'info';
    let wrap = document.getElementById('uidToasts');
    if (!wrap) {
      wrap = document.createElement('div'); wrap.id = 'uidToasts'; wrap.className = 'uid-toasts';
      wrap.setAttribute('aria-live', 'polite'); document.body.appendChild(wrap);
    }
    while (wrap.children.length >= 4) wrap.firstElementChild.remove();   // never a pile
    const el = document.createElement('div');
    el.className = 'uid-toast uid-' + kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.innerHTML = '<i class="fa-solid ' + ICON[kind] + '" aria-hidden="true"></i><span class="uid-toast-text"></span><button type="button" class="uid-toast-x" aria-label="Dismiss">×</button>';
    el.querySelector('.uid-toast-text').textContent = String(message == null ? '' : message);
    wrap.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('on'); });
    const life = ms || (kind === 'error' ? 7000 : kind === 'warn' ? 5500 : 4000);
    let timer = setTimeout(close, life);
    function close() {
      clearTimeout(timer); el.classList.remove('on');
      setTimeout(function () { el.remove(); if (wrap && !wrap.children.length) wrap.remove(); }, 220);
    }
    el.querySelector('.uid-toast-x').addEventListener('click', close);
    el.addEventListener('mouseenter', function () { clearTimeout(timer); });
    el.addEventListener('mouseleave', function () { timer = setTimeout(close, 1500); });
    return el;
  }

  function uiDialog(o) {
    ensureCss();
    return new Promise(function (resolve) {
      const isConfirm = !!o.confirm;
      const danger = !!o.danger;
      const kind = danger ? 'error' : (KINDS.indexOf(o.kind) >= 0 ? o.kind : 'info');
      const text = String(o.message == null ? '' : o.message);
      const old = document.getElementById('uidOverlay'); if (old) old.remove();
      const ov = document.createElement('div');
      ov.id = 'uidOverlay'; ov.className = 'uid-overlay';
      ov.setAttribute('role', isConfirm ? 'alertdialog' : 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'uidTitle');
      ov.innerHTML =
        '<div class="uid-pop">' +
        '<div class="uid-icon uid-' + kind + '"><i class="fa-solid ' + ICON[kind] + '" aria-hidden="true"></i></div>' +
        '<h3 class="uid-title" id="uidTitle"></h3><p class="uid-msg"></p>' +
        '<div class="uid-actions">' + (isConfirm ? '<button type="button" class="uid-btn uid-btn-cancel"></button>' : '') +
        '<button type="button" class="uid-btn uid-btn-ok' + (danger ? ' uid-btn-danger' : '') + '"></button></div></div>';
      /* the buttons are uid-btn-* on purpose: the icon carries the KIND class (uid-ok, uid-error…), and a
         query for ".uid-ok" on a success dialog would find the icon first — a real bug caught in testing */
      ov.querySelector('.uid-title').textContent = o.title || (isConfirm ? (danger ? 'Are you sure?' : 'Please confirm') : TITLE[kind]);
      const msg = ov.querySelector('.uid-msg'); msg.textContent = text;
      if (text.length < 90 && text.indexOf('\n') < 0) msg.classList.add('uid-short');
      const okBtn = ov.querySelector('.uid-btn-ok'); okBtn.textContent = o.okLabel || 'OK';
      const cancelBtn = ov.querySelector('.uid-btn-cancel'); if (cancelBtn) cancelBtn.textContent = o.cancelLabel || 'Cancel';
      document.body.appendChild(ov);
      requestAnimationFrame(function () { ov.classList.add('on'); });
      const prev = document.activeElement;
      (isConfirm && danger && cancelBtn ? cancelBtn : okBtn).focus();   // a stray Enter must never delete
      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        ov.classList.remove('on');
        setTimeout(function () { ov.remove(); }, 200);
        try { if (prev && prev.focus) prev.focus(); } catch (_) { }
        resolve(result);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); close(isConfirm ? false : undefined); return; }
        if (ev.key === 'Tab') {
          const els = isConfirm ? [cancelBtn, okBtn] : [okBtn];
          const i = els.indexOf(document.activeElement);
          ev.preventDefault(); els[(i + (ev.shiftKey ? els.length - 1 : 1)) % els.length].focus();
        }
      }
      document.addEventListener('keydown', onKey, true);
      okBtn.addEventListener('click', function () { close(isConfirm ? true : undefined); });
      if (cancelBtn) cancelBtn.addEventListener('click', function () { close(false); });
      ov.addEventListener('click', function (ev) { if (ev.target === ov) close(isConfirm ? false : undefined); });
    });
  }
  function uiAlert(message, options) { return uiDialog(Object.assign({ message: message, confirm: false }, options || {})); }
  function uiConfirm(message, options) { return uiDialog(Object.assign({ message: message, confirm: true }, options || {})); }

  /* the replacement for alert(). Short -> toast. Long, or more than one line -> dialog. */
  const nativeAlert = typeof window.alert === 'function' ? window.alert.bind(window) : function () { };
  function uiAlertShim(message) {
    if (!document.body) return nativeAlert(message);            // too early in the page for anything of ours
    const text = String(message == null ? '' : message);
    const kind = uiKindOf(text);
    const lines = text.split('\n').filter(function (l) { return l.trim(); }).length;
    if (lines >= 2 || text.length > 140) uiAlert(text, { kind: kind });
    else uiToast(text, kind);
  }

  window.uiToast = uiToast;
  window.uiAlert = uiAlert;
  window.uiConfirm = uiConfirm;
  window.uiKindOf = uiKindOf;
  window.nativeAlert = nativeAlert;
  window.alert = uiAlertShim;
})();
