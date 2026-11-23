/* No networking here: consent refers to an immutable native snapshot. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.MobileCodexReports = factory;
})(typeof window === 'object' ? window : globalThis, function(options) {
  'use strict';
  const {document, call, t, show, close} = options;
  const $ = id => document.getElementById(id);
  let reportId = '', sending = false, epoch = 0, availabilityRevision = 0, cancelling = null;
  let statusKey = '';
  const status = key => { statusKey = key; $('report-status').textContent = t(key); };
  function controls() { $('report-send').disabled = sending || !reportId; $('report-send').textContent = t(sending ? '正在发送…' : '发送到公开 GitHub'); }
  function launchers(available) {
    for (const id of ['report-open', 'report-error-open']) $(id).hidden = !available;
  }
  function clearPreview() {
    ++epoch; reportId = '';
    $('report-payload').textContent = '';
    controls();
  }
  function available(value) {
    ++availabilityRevision;
    const active = value === true || value?.available === true;
    launchers(active);
    if (!active || value?.previewInvalidated === true) {
      clearPreview();
      $('report-result').hidden = true;
      delete $('report-result').dataset.url;
      if (!sending) status(active ? '错误报告已发生变化，请重新打开以查看最新内容。' : '目前没有可发送的错误报告。发生错误后请重新打开。');
    }
  }
  async function refresh() {
    const revision = availabilityRevision;
    try {
      const value = await call('reports.status');
      if (revision === availabilityRevision) available(value);
    } catch { /* Keep launchers hidden until native availability is known. */ }
  }
  launchers(false);
  controls();
  async function open() {
    if (cancelling) await cancelling;
    if (sending) { show('report-dialog'); return; }
    const generation = ++epoch; reportId = ''; controls();
    $('report-payload').textContent = ''; $('report-result').hidden = true;
    status('正在准备错误报告。'); show('report-dialog');
    try {
      const value = await call('reports.preview'); if (generation !== epoch) return;
      if (value.status !== 'preview') { if (value.status === 'unavailable') available(false); status('目前没有可发送的错误报告。发生错误后请重新打开。'); return; }
      reportId = value.reportId;
      $('report-payload').textContent = JSON.stringify(value.payload, null, 2);
      status(''); controls();
    } catch { if (generation === epoch) status('无法准备报告，请重新打开。'); }
  }
  async function send() {
    if (sending || !reportId) return;
    sending = true; const revision = availabilityRevision; controls();
    status('正在发送。即使取消，已发布的报告仍可能保留。');
    try {
      const value = await call('reports.send', {reportId, consent:true});
      if (value.status === 'sent' && /^https:\/\/github\.com\/nokryong\/mobile-codex\/issues\/[1-9][0-9]*$/.test(value.url)) {
        $('report-result').dataset.url = value.url; $('report-result').hidden = false;
        status(value.grouped ? '已合并到相同错误的现有 Issue。' : '错误报告已发布到 GitHub。');
        clearPreview();
        if (revision === availabilityRevision) launchers(false);
      } else status(value.status === 'cancelled' ? '已取消发送。若要重试，请重新打开错误报告并确认。' : '无法确认是否提交。请检查网络后重试，相同报告不会重复发布。');
    } catch { status('无法确认是否提交。请检查网络后重试，相同报告不会重复发布。'); }
    finally { sending = false; controls(); }
  }
  async function cancel() {
    if (cancelling) return cancelling;
    clearPreview();
    if (sending) status('正在取消…');
    else close('report-dialog');
    // Reopening waits for native revocation, so an older cancel cannot erase
    // a newly requested consent snapshot. The report itself remains retryable.
    cancelling = call('reports.cancel').catch(() => {});
    try { await cancelling; } finally { cancelling = null; }
  }
  $('report-send').addEventListener('click', send);
  $('report-open').addEventListener('click', open);
  $('report-error-open').addEventListener('click', () => { close('header-menu-dialog'); open(); });
  $('report-result').addEventListener('click', () => call('ui.externalBrowser', {url:$('report-result').dataset.url}).catch(() => status('无法打开链接，请重试。')));
  document.addEventListener?.('mobilecodex:languagechange', () => { controls(); status(statusKey); });
  return {open, send, cancel, available, refresh, isSending:() => sending};
});
