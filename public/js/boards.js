// Boards: collections of jackets, read-only share links, CSV + live Google Sheets feed.
import { api, esc, icon, money, toast, openModal, closeModal, confirmDialog, copyText, plural, sourceLabel, $, $$ } from './core.js';
import { me, has } from './session.js';

// "Add to board" picker (used from cards, the jacket page and the bulk bar)
export async function addToBoard(ids) {
  ids = [].concat(ids).map(Number);
  const { boards } = await api('/boards');
  const m = openModal(`
    <div class="row-between"><h2 class="modal-title">Add ${plural(ids.length, 'jacket')} to a board</h2><button class="icon-btn" data-x aria-label="Close">${icon('x')}</button></div>
    <div class="board-pick">${boards.map(b => `<button class="bp-item" data-b="${b.id}"><span class="bp-covers">${b.covers.slice(0, 3).map(c => `<img src="${esc(c)}" alt="">`).join('') || icon('board', 20)}</span><span><b>${esc(b.name)}</b><small>${plural(b.count, 'jacket')}</small></span>${icon('plus', 16)}</button>`).join('') || '<p class="muted">No boards yet — make your first one below.</p>'}</div>
    <div class="row2 new-board"><input id="nbName" placeholder="New board name, e.g. Winter drop" maxlength="60"><button class="btn gold" id="nbGo">${icon('plus', 15)} Create & add</button></div>`, { label: 'Add to board' });
  m.querySelector('[data-x]').onclick = closeModal;
  const add = async (id, name) => {
    await api('/boards/' + id, { method: 'PUT', body: { add: ids } });
    closeModal();
    toast(`Added to “${name}”`, { action: 'Open board', onAction: () => { location.hash = '#/boards/' + id; } });
  };
  m.querySelectorAll('[data-b]').forEach(b => b.onclick = () => add(b.dataset.b, boards.find(x => x.id === b.dataset.b).name));
  const create = async () => {
    const name = m.querySelector('#nbName').value.trim();
    if (!name) return m.querySelector('#nbName').focus();
    const b = await api('/boards', { method: 'POST', body: { name } });
    add(b.id, b.name);
  };
  m.querySelector('#nbGo').onclick = create;
  m.querySelector('#nbName').onkeydown = e => { if (e.key === 'Enter') create(); };
}

export async function renderBoards(app, params) {
  app.innerHTML = '<div class="skel-block tall"></div>';
  const { boards } = await api('/boards');
  const canEdit = has('boards.edit');
  app.innerHTML = `
  <header class="page-head"><div><p class="eyebrow">Boards</p><h1>Your collections</h1><p class="lead-line">Group jackets you like (e.g. “Winter drop”) and share a link with your team or maker.</p></div>
    ${canEdit ? `<div class="head-actions"><button class="btn gold" id="newBoard">${icon('plus', 16)} New board</button></div>` : ''}</header>
  <section class="boards">${boards.map(b => `
    <a class="board-card" href="#/boards/${b.id}">
      <span class="bc-covers">${[0, 1, 2, 3].map(i => b.covers[i] ? `<img src="${esc(b.covers[i])}" alt="" loading="lazy">` : '<i></i>').join('')}</span>
      <span class="bc-body"><b>${esc(b.name)}</b><small>${plural(b.count, 'jacket')} · by ${esc(b.by)}</small>${b.shareUrl || b.shared ? `<span class="pill gold">${icon('share', 12)} Shared</span>` : ''}</span>
    </a>`).join('') || `<div class="empty">${icon('board', 38)}<h2>No boards yet</h2><p>Group jackets into collections like “Winter drop” or “For supplier X”, then share a read-only link.</p></div>`}
  </section>`;
  const make = async () => {
    const m = openModal(`<h2 class="modal-title">New board</h2>
      <label class="field"><span>Name</span><input id="bn" maxlength="60" placeholder="e.g. Winter drop" autofocus></label>
      <label class="field"><span>Note (optional)</span><input id="bnote" maxlength="200" placeholder="What is this board for?"></label>
      <div class="modal-actions"><button class="btn ghost" data-c>Cancel</button><button class="btn gold" data-ok>Create board</button></div>`, { label: 'New board' });
    m.querySelector('[data-c]').onclick = closeModal;
    const go = async () => { const name = m.querySelector('#bn').value.trim(); if (!name) return; const b = await api('/boards', { method: 'POST', body: { name, note: m.querySelector('#bnote').value } }); closeModal(); location.hash = '#/boards/' + b.id; };
    m.querySelector('[data-ok]').onclick = go;
    m.querySelector('#bn').onkeydown = e => { if (e.key === 'Enter') go(); };
  };
  $('#newBoard')?.addEventListener('click', make);
  if (params.get('new') && canEdit) make();
}

export async function renderBoard(app, id) {
  app.innerHTML = '<div class="skel-block tall"></div>';
  let b;
  try { b = await api('/boards/' + id); } catch (e) { app.innerHTML = `<div class="empty"><h2>Board not found</h2><a class="btn ghost" href="#/boards">All boards</a></div>`; return; }
  const canEdit = has('boards.edit');
  const sheets = b.shareUrl ? `=IMPORTDATA("${b.shareUrl}.csv")` : '';
  app.innerHTML = `
  <nav class="crumbs"><a href="#/boards">${icon('chevronL', 16)} Boards</a></nav>
  <header class="page-head"><div><p class="eyebrow">Board · ${plural(b.count, 'jacket')}</p><h1 id="bTitle" ${canEdit ? 'contenteditable="plaintext-only" spellcheck="false" title="Click to rename"' : ''}>${esc(b.name)}</h1>${b.note ? `<p class="muted">${esc(b.note)}</p>` : ''}</div>
    <div class="head-actions">
      <a class="btn ghost" href="/api/export.csv?board=${b.id}" download>${icon('download', 15)} CSV</a>
      ${canEdit ? `<button class="btn ${b.shareUrl ? 'gold' : 'ghost'}" id="share" data-perm="boards.share">${icon('share', 15)} ${b.shareUrl ? 'Shared' : 'Share'}</button><button class="icon-btn" id="del" aria-label="Delete board">${icon('trash')}</button>` : ''}
    </div></header>
  ${b.shareUrl ? `<section class="share-box">
    <div><b>${icon('link', 15)} Read-only link</b><small class="muted">Anyone with the link can see these jackets — no login needed. Your notes, profit and team stay private.</small></div>
    <div class="copy-row"><input readonly value="${esc(b.shareUrl)}"><button class="btn sm ghost" data-copy="${esc(b.shareUrl)}">${icon('copy', 14)} Copy</button><a class="btn sm ghost" href="${esc(b.shareUrl)}" target="_blank" rel="noopener">${icon('external', 14)} Open</a></div>
    <div><b>${icon('database', 15)} Live Google Sheets</b><small class="muted">Paste into cell A1 of a Google Sheet — it refreshes automatically.</small></div>
    <div class="copy-row"><input readonly value="${esc(sheets)}"><button class="btn sm ghost" data-copy="${esc(sheets)}">${icon('copy', 14)} Copy</button></div>
  </section>` : ''}
  <section class="grid">${b.items.map(p => `
    <article class="card status-${p.status}">
      <a class="card-media" href="#/product/${p.id}"><img src="${esc(p.thumb || p.mainImage)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="badge src">${esc(sourceLabel(p))}</span></a>
      ${canEdit ? `<div class="card-tools"><button class="tool" data-rm="${p.id}" aria-label="Remove from board" title="Remove from board">${icon('x', 16)}</button></div>` : ''}
      <div class="card-body"><a class="card-title" href="#/product/${p.id}">${esc(p.title)}</a>
        <div class="card-meta"><span class="price">${money(p.price, p.currency)}</span>${p.profit ? `<span class="profit ${p.profit.profit < 0 ? 'neg' : ''}">${money(p.profit.profit)} profit</span>` : ''}</div></div>
    </article>`).join('') || `<div class="empty">${icon('board', 34)}<h2>Empty board</h2><p>Use “Add to board” on any jacket.</p><a class="btn gold" href="#/jackets">Browse jackets</a></div>`}</section>`;
  $$('[data-copy]').forEach(x => x.onclick = async () => toast(await copyText(x.dataset.copy) ? 'Copied' : 'Select the text and copy it'));
  $$('[data-rm]').forEach(x => x.onclick = async () => { await api('/boards/' + b.id, { method: 'PUT', body: { remove: [Number(x.dataset.rm)] } }); x.closest('.card').remove(); toast('Removed from board'); });
  $('#share')?.addEventListener('click', async () => {
    if (b.shareUrl && !(await confirmDialog({ title: 'Turn off the share link?', body: 'People with the link will no longer see this board.', confirm: 'Turn off' }))) return;
    await api('/boards/' + b.id, { method: 'PUT', body: { share: !b.shareUrl } });
    renderBoard(app, id);
  });
  $('#del')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: `Delete “${b.name}”?`, body: 'The jackets stay in Morrow Studio — only the board is removed.', confirm: 'Delete board', danger: true }))) return;
    await api('/boards/' + b.id, { method: 'DELETE' }); location.hash = '#/boards'; toast('Board deleted');
  });
  const t = $('#bTitle');
  if (t && canEdit) {
    t.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } });
    t.addEventListener('blur', async () => { const name = t.textContent.trim(); if (name && name !== b.name) { await api('/boards/' + b.id, { method: 'PUT', body: { name } }); b.name = name; toast('Renamed'); } else t.textContent = b.name; });
  }
}
