// Leseliste – gelesene Bücher tracken + KI-Vorschläge (Claude API)
// Alle Daten bleiben lokal auf dem Gerät (localStorage).

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- Speicher ----------
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem('leseliste.' + key)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) { localStorage.setItem('leseliste.' + key, JSON.stringify(value)); },
};

let books = store.get('books', []);
let wishlist = store.get('wishlist', []);
let settings = store.get('settings', { apiKey: '', model: 'claude-opus-5-5' });
let groupMode = store.get('groupMode', 'month');
const saveBooks = () => store.set('books', books);
const saveWishlist = () => store.set('wishlist', wishlist);

// ---------- Hilfsfunktionen ----------
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = (s = '') => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
// "end" ist ein volles Datum (2026-10-05) oder nur ein Jahr (2026), z. B. bei importierten Listen
const fmtDate = (d) => !d ? '' : d.length === 4 ? d : new Date(d + 'T00:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });

function coverHtml(book, cls = 'cover') {
  if (book.cover) return `<img class="${cls}" src="${esc(book.cover)}" alt="" loading="lazy" data-initial="${esc((book.title || '?')[0])}">`;
  return `<div class="${cls}">${esc((book.title || '?')[0].toUpperCase())}</div>`;
}
// Kaputte Cover-Bilder durch Platzhalter ersetzen
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.classList.contains('cover')) {
    const div = document.createElement('div');
    div.className = img.className;
    div.textContent = (img.dataset.initial || '?').toUpperCase();
    img.replaceWith(div);
  }
}, true);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busyText').textContent = text;
}

// ---------- Online-Buchsuche (Cover & Metadaten) ----------
async function searchBooks(query, max = 8) {
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${max}&printType=books`);
    const data = await r.json();
    const items = (data.items || []).map((it) => ({
      title: it.volumeInfo.title + (it.volumeInfo.subtitle ? ': ' + it.volumeInfo.subtitle : ''),
      author: (it.volumeInfo.authors || []).join(', '),
      year: (it.volumeInfo.publishedDate || '').slice(0, 4),
      cover: (it.volumeInfo.imageLinks?.thumbnail || '').replace('http://', 'https://'),
    }));
    if (items.length) return items;
  } catch { /* weiter mit Open Library */ }
  try {
    const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query.replace(/in(title|author):/g, ''))}&lang=de&limit=${max}`);
    const data = await r.json();
    return (data.docs || []).map((d) => ({
      title: d.title,
      author: (d.author_name || []).join(', '),
      year: d.first_publish_year ? String(d.first_publish_year) : '',
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
    }));
  } catch { return []; }
}

async function findCover(title, author) {
  // Nur Treffer vom richtigen Autor nehmen (gleicher Titel gibt's oft mehrfach)
  const surname = norm((author || '').split(/[,&]/)[0].trim().split(' ').pop());
  const ok = (r) => r.cover && (!surname || norm(r.author).includes(surname));
  const hit = (await searchBooks(`intitle:${title}${surname ? ' inauthor:' + surname : ''}`, 5)).find(ok) ||
    (await searchBooks(`${title} ${author || ''}`, 5)).find(ok);
  return hit?.cover || '';
}

// Fehlende Cover beim Start nochmal suchen (z. B. wenn die Quelle beim Import gerade nicht ging)
async function fillMissingCovers() {
  for (const b of books.filter((x) => !x.cover)) {
    const url = await findCover(b.title, b.author);
    if (url) { b.cover = url; saveBooks(); renderLibrary(); }
  }
}

// ---------- Claude API ----------
let Anthropic;
async function callClaude({ content, schema, effort }) {
  if (!settings.apiKey) {
    const err = new Error('Bitte zuerst in den Einstellungen einen API-Schlüssel eintragen.');
    err.noKey = true;
    throw err;
  }
  if (!Anthropic) ({ default: Anthropic } = await import('https://esm.sh/@anthropic-ai/sdk'));
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model: settings.model,
    max_tokens: 16000,
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  };
  let msg;
  try {
    // Opus/Sonnet: bei einer (seltenen) Ablehnung automatisch auf ein Ersatzmodell ausweichen
    msg = settings.model === 'claude-haiku-5-5'
      ? await client.messages.create(params)
      : await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('API-Schlüssel ungültig – bitte in den Einstellungen prüfen.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Zu viele Anfragen – bitte kurz warten.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Keine Verbindung zur KI – bist du online?');
    if (e instanceof Anthropic.APIError) throw new Error(`KI-Fehler (${e.status ?? '?'}): ${e.message}`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new Error('Die KI hat diese Anfrage abgelehnt.');
  if (msg.stop_reason === 'max_tokens') throw new Error('Antwort der KI war unvollständig – bitte nochmal versuchen.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// ---------- Bild verkleinern ----------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
function resize(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

// ---------- Navigation ----------
const titles = { library: 'Bibliothek', discover: 'Entdecken', settings: 'Einstellungen' };
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#viewTitle').textContent = titles[name];
  $('#fab').hidden = name !== 'library';
  if (name === 'discover') renderDiscover();
  window.scrollTo(0, 0);
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- Bibliothek ----------
function renderLibrary() {
  const now = new Date();
  const y = String(now.getFullYear());
  const ym = today().slice(0, 7);
  $('#stats').innerHTML = `
    <div class="stat"><b>${books.length}</b><span>Gesamt</span></div>
    <div class="stat"><b>${books.filter((b) => b.end?.startsWith(y)).length}</b><span>In ${y}</span></div>
    <div class="stat"><b>${books.filter((b) => b.end?.startsWith(ym)).length}</b><span>Diesen Monat</span></div>`;

  $$('.segmented button').forEach((b) => b.classList.toggle('active', b.dataset.group === groupMode));

  const q = norm($('#librarySearch').value);
  const list = books
    .filter((b) => !q || norm(b.title + b.author).includes(q))
    .sort((a, b) => (b.end || '').localeCompare(a.end || '') || (b.added || 0) - (a.added || 0));

  if (!books.length) {
    $('#bookList').innerHTML = `<div class="empty"><div class="big">📖</div>
      Noch keine Bücher eingetragen.<br>Tippe auf <b>+</b>, um dein erstes Buch hinzuzufügen.</div>`;
    return;
  }
  if (!list.length) { $('#bookList').innerHTML = '<div class="empty">Nichts gefunden.</div>'; return; }

  const groups = new Map();
  for (const b of list) {
    const key = (b.end || '').slice(0, groupMode === 'month' ? 7 : 4) || 'ohne Datum';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  $('#bookList').innerHTML = [...groups].map(([key, items]) => {
    const label = key === 'ohne Datum' ? 'Ohne Datum'
      : key.length === 7
        ? new Date(key + '-01T00:00').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
        : groupMode === 'month' ? `${key} · ohne Monat` : key;
    return `<div class="group-title">${esc(label)}<small>${items.length} ${items.length === 1 ? 'Buch' : 'Bücher'}</small></div>` +
      items.map((b) => `
        <div class="book" data-id="${b.id}">
          ${coverHtml(b)}
          <div class="meta">
            <div class="title">${esc(b.title)}</div>
            <div class="author">${esc(b.author)}</div>
            <div class="date">${b.start ? fmtDate(b.start) + ' – ' : ''}${fmtDate(b.end)}</div>
            ${b.rating ? `<div class="rating">${'★'.repeat(b.rating)}${'☆'.repeat(5 - b.rating)}</div>` : ''}
          </div>
        </div>`).join('');
  }).join('');
}
$$('.segmented button').forEach((b) => b.addEventListener('click', () => {
  groupMode = b.dataset.group; store.set('groupMode', groupMode); renderLibrary();
}));
$('#librarySearch').addEventListener('input', renderLibrary);
$('#bookList').addEventListener('click', (e) => {
  const el = e.target.closest('.book');
  if (el) openBookForm(books.find((b) => b.id === el.dataset.id));
});

// ---------- Sheets ----------
function openSheet(id) { $(id).hidden = false; }
function closeSheets() { $$('.sheet-backdrop').forEach((s) => (s.hidden = true)); }
$$('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
$$('.sheet-backdrop').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) closeSheets(); }));

$('#fab').addEventListener('click', () => openSheet('#addMenu'));
$('#manualBtn').addEventListener('click', () => { closeSheets(); openBookForm(); });

// ---------- Buch-Formular ----------
let editing = null;   // Buch, das gerade bearbeitet wird (oder null für neu)
let formCover = '';
let formRating = 0;

function renderStars() {
  $('#fRating').innerHTML = [1, 2, 3, 4, 5].map((n) =>
    `<span data-n="${n}" class="${n <= formRating ? 'on' : ''}">★</span>`).join('');
}
$('#fRating').addEventListener('click', (e) => {
  const n = Number(e.target.dataset.n);
  if (n) { formRating = formRating === n ? 0 : n; renderStars(); }
});

function setFormCover(url) {
  formCover = url || '';
  const img = $('#coverPreview');
  if (formCover) img.src = formCover; else img.removeAttribute('src');
}

function openBookForm(book = null, prefill = {}) {
  editing = book;
  const data = { ...(book || {}), ...prefill };
  $('#formTitle').textContent = book ? 'Buch bearbeiten' : 'Neues Buch';
  $('#searchBox').hidden = !!book;
  $('#onlineSearch').value = '';
  $('#searchResults').innerHTML = '';
  $('#fTitle').value = data.title || '';
  $('#fAuthor').value = data.author || '';
  $('#fStart').value = data.start || '';
  const yearOnly = data.end?.length === 4;
  $('#fEnd').value = yearOnly ? '' : data.end || today();
  $('#yearOnlyHint').hidden = !yearOnly;
  $('#yearOnlyHint').textContent = `Gelesen ${data.end} – genaues Datum optional, leer lassen behält „${data.end}“.`;
  $('#fNotes').value = data.notes || '';
  formRating = data.rating || 0;
  renderStars();
  setFormCover(data.cover);
  $('#deleteBtn').hidden = !book;
  openSheet('#bookSheet');
}

let searchTimer;
let lastResults = [];
$('#onlineSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 3) { $('#searchResults').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    $('#searchResults').innerHTML = '<p class="hint">Suche …</p>';
    lastResults = await searchBooks(q);
    $('#searchResults').innerHTML = lastResults.length
      ? lastResults.map((r, i) => `
        <div class="result" data-i="${i}">
          ${coverHtml(r)}
          <div><b>${esc(r.title)}</b><br><small>${esc(r.author)}${r.year ? ' · ' + r.year : ''}</small></div>
        </div>`).join('')
      : '<p class="hint">Nichts gefunden – einfach unten von Hand eintragen.</p>';
  }, 400);
});
$('#searchResults').addEventListener('click', (e) => {
  const el = e.target.closest('.result');
  if (!el) return;
  const r = lastResults[el.dataset.i];
  // Manche Treffer kommen im Originaltitel (z. B. Japanisch) – dann das Getippte behalten
  const latin = (s) => /[A-Za-zÀ-ž]/.test(s);
  $('#fTitle').value = latin(r.title) ? r.title : $('#onlineSearch').value.trim();
  $('#fAuthor').value = latin(r.author) ? r.author : '';
  setFormCover(r.cover);
  $('#searchResults').innerHTML = '';
  $('#onlineSearch').value = '';
});

$('#bookForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const start = $('#fStart').value;
  const end = $('#fEnd').value || (editing?.end?.length === 4 ? editing.end : '');
  if (!end) { toast('Bitte angeben, wann du das Buch beendet hast.'); return; }
  if (start && end.length === 10 && start > end) { toast('Beginn liegt nach dem Ende.'); return; }
  const data = {
    title: $('#fTitle').value.trim(),
    author: $('#fAuthor').value.trim(),
    start, end,
    rating: formRating,
    notes: $('#fNotes').value.trim(),
    cover: formCover,
  };
  if (editing) Object.assign(editing, data);
  else books.push({ id: uid(), added: Date.now(), ...data });
  const saved = editing || books[books.length - 1];
  saveBooks();
  closeSheets();
  renderLibrary();
  toast(editing ? 'Gespeichert' : `„${data.title}“ hinzugefügt`);
  // Fehlt ein Cover, im Hintergrund eins suchen
  if (!data.cover) {
    const url = await findCover(data.title, data.author);
    if (url) { saved.cover = url; saveBooks(); renderLibrary(); }
  }
});

$('#coverInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { setFormCover(resize(await loadImage(file), 300, 0.75)); }
  catch { toast('Foto konnte nicht geladen werden.'); }
});

$('#deleteBtn').addEventListener('click', () => {
  if (!editing || !confirm(`„${editing.title}“ wirklich löschen?`)) return;
  books = books.filter((b) => b !== editing);
  saveBooks(); closeSheets(); renderLibrary();
  toast('Gelöscht');
});

// ---------- Liste einfügen (z. B. aus der Notizen-App) ----------
function parseList(text) {
  return text.split('\n')
    .map((line) => line.replace(/^\s*(?:[-–•*✓✔☑○●◦]|\[[ xX]?\]|\d+[.)])?\s*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      // "Autor - Titel", auch "Autor- Titel" / "Autor -Titel" (Bindestriche in Wörtern bleiben)
      const parts = line.split(/\s+[-–—]\s*|\s*[-–—]\s+/);
      return parts.length > 1
        ? { author: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
        : { author: '', title: line };
    });
}
function updatePastePreview() {
  const items = parseList($('#pasteText').value);
  const known = new Set(books.map((b) => norm(b.title)));
  const dupes = items.filter((i) => known.has(norm(i.title))).length;
  $('#pastePreview').textContent = items.length
    ? `${items.length - dupes} neue Bücher erkannt${dupes ? `, ${dupes} schon vorhanden (werden übersprungen)` : ''}.`
    : '';
}
$('#pasteBtn').addEventListener('click', () => {
  closeSheets();
  $('#pasteText').value = '';
  $('#pasteYear').value = new Date().getFullYear();
  updatePastePreview();
  openSheet('#pasteSheet');
});
$('#pasteText').addEventListener('input', updatePastePreview);
$('#pasteImport').addEventListener('click', async () => {
  const year = $('#pasteYear').value;
  if (!/^\d{4}$/.test(year)) { toast('Bitte ein gültiges Jahr angeben.'); return; }
  const known = new Set(books.map((b) => norm(b.title)));
  const items = parseList($('#pasteText').value).filter((i) => !known.has(norm(i.title)));
  if (!items.length) { toast('Keine neuen Bücher gefunden.'); return; }
  // Spätere Zeilen = später gelesen → erscheinen weiter oben
  const base = Date.now();
  const added = items.map((i, n) => ({
    id: uid(), added: base + n, title: i.title, author: i.author,
    start: '', end: year, rating: 0, notes: '', cover: '',
  }));
  books.push(...added);
  saveBooks(); closeSheets(); renderLibrary();
  toast(`${added.length} Bücher importiert – Cover werden geladen …`);
  for (const b of added) {
    b.cover = await findCover(b.title, b.author);
    if (b.cover) { saveBooks(); renderLibrary(); }
  }
});

// ---------- Foto vom Cover ----------
$('#photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  closeSheets();
  let img;
  try { img = await loadImage(file); } catch { toast('Foto konnte nicht geladen werden.'); return; }
  const thumb = resize(img, 300, 0.7);
  if (!settings.apiKey) {
    toast('Ohne API-Schlüssel bitte Titel selbst eintippen.');
    openBookForm(null, { cover: thumb });
    return;
  }
  busy('Cover wird erkannt …');
  try {
    const photo = resize(img, 1024, 0.8).split(',')[1];
    const res = await callClaude({
      effort: 'low',
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          title: { type: 'string' },
          author: { type: 'string' },
        },
        required: ['found', 'title', 'author'],
        additionalProperties: false,
      },
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo } },
        { type: 'text', text: 'Auf dem Foto ist ein Buch (meist das Cover). Bestimme Titel und Autor:in des Buches so, wie sie auf dem Cover stehen. Wenn du das Buch nicht sicher erkennst, setze found=false und gib zurück, was lesbar ist (sonst leere Strings).' },
      ],
    });
    busy('Cover wird gesucht …');
    const cover = res.title ? await findCover(res.title, res.author) : '';
    busy();
    if (!res.found) toast('Nicht sicher erkannt – bitte prüfen.');
    openBookForm(null, { title: res.title, author: res.author, cover: cover || thumb });
  } catch (err) {
    busy();
    toast(err.message);
    openBookForm(null, { cover: thumb });
  }
});

// ---------- Entdecken / KI-Vorschläge ----------
const picked = new Set();

function renderDiscover() {
  const sorted = [...books].sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.end || '').localeCompare(a.end || ''));
  for (const id of picked) if (!books.some((b) => b.id === id)) picked.delete(id);
  $('#pickList').innerHTML = sorted.length
    ? sorted.map((b) => `
      <div class="pick ${picked.has(b.id) ? 'selected' : ''}" data-id="${b.id}">
        ${coverHtml(b)}<div class="ptitle">${esc(b.title)}</div>
      </div>`).join('')
    : '<p class="hint">Trage zuerst ein paar gelesene Bücher ein.</p>';
  $('#recommendBtn').disabled = !picked.size;
  $('#recommendBtn').textContent = picked.size
    ? `✨ Vorschläge zu ${picked.size} ${picked.size === 1 ? 'Buch' : 'Büchern'} holen`
    : '✨ Bücher oben antippen';
  renderWishlist();
}
$('#pickList').addEventListener('click', (e) => {
  const el = e.target.closest('.pick');
  if (!el) return;
  picked.has(el.dataset.id) ? picked.delete(el.dataset.id) : picked.add(el.dataset.id);
  renderDiscover();
});

const shopLinks = (r) => {
  const q = encodeURIComponent(`${r.title} ${r.author}`);
  return `<a href="https://www.amazon.de/s?k=${q}&i=stripbooks" target="_blank" rel="noopener">Amazon</a>
          <a href="https://www.thalia.de/suche?sq=${q}" target="_blank" rel="noopener">Thalia</a>`;
};

let lastRecos = [];
function renderRecos() {
  $('#recoResult').innerHTML = lastRecos.map((r, i) => `
    <div class="reco">
      <div class="reco-head">
        ${coverHtml(r)}
        <div class="grow">
          <h3>${esc(r.title)}</h3>
          <div class="author">${esc(r.author)}${r.year ? ' · ' + esc(r.year) : ''}</div>
          ${r.genre ? `<span class="tag">${esc(r.genre)}</span>` : ''}
        </div>
      </div>
      <p>${esc(r.reason)}</p>
      <div class="links">
        ${shopLinks(r)}
        <button data-save="${i}" ${wishlist.some((w) => norm(w.title) === norm(r.title)) ? 'disabled' : ''}>🔖 Merken</button>
      </div>
    </div>`).join('');
}
$('#recoResult').addEventListener('click', (e) => {
  const i = e.target.dataset.save;
  if (i === undefined) return;
  wishlist.unshift({ ...lastRecos[i], id: uid() });
  saveWishlist(); renderRecos(); renderWishlist();
  toast('Auf die Merkliste gesetzt');
});

function renderWishlist() {
  $('#wishlistTitle').hidden = !wishlist.length;
  $('#wishlist').innerHTML = wishlist.map((w) => `
    <div class="reco">
      <div class="reco-head">
        ${coverHtml(w)}
        <div class="grow">
          <h3>${esc(w.title)}</h3>
          <div class="author">${esc(w.author)}</div>
        </div>
      </div>
      <div class="links" style="margin-top:10px">
        ${shopLinks(w)}
        <button data-read="${w.id}">✅ Gelesen</button>
        <button data-del="${w.id}" class="danger">✕</button>
      </div>
    </div>`).join('');
}
$('#wishlist').addEventListener('click', (e) => {
  const { read, del } = e.target.dataset;
  const w = wishlist.find((x) => x.id === (read || del));
  if (!w) return;
  wishlist = wishlist.filter((x) => x !== w);
  saveWishlist(); renderWishlist(); renderRecos();
  if (read) openBookForm(null, { title: w.title, author: w.author, cover: w.cover });
});

$('#recommendBtn').addEventListener('click', async () => {
  const liked = books.filter((b) => picked.has(b.id));
  const describe = (b) => `- „${b.title}“ von ${b.author || 'unbekannt'}` +
    (b.rating ? ` (Bewertung ${b.rating}/5)` : '') + (b.notes ? ` – Notiz: ${b.notes}` : '');
  const alreadyKnown = [...books, ...wishlist].map((b) => `- ${b.title} (${b.author || '?'})`).join('\n');
  const wish = $('#wishText').value.trim();

  busy('Die KI sucht passende Bücher …');
  try {
    const res = await callClaude({
      effort: 'medium',
      schema: {
        type: 'object',
        properties: {
          recommendations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                author: { type: 'string' },
                year: { type: 'string' },
                genre: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['title', 'author', 'year', 'genre', 'reason'],
              additionalProperties: false,
            },
          },
        },
        required: ['recommendations'],
        additionalProperties: false,
      },
      content: `Du bist eine begeisterte, belesene Buchhändlerin. Diese Bücher haben mir gefallen:
${liked.map(describe).join('\n')}

Schlage mir 3 bis 5 neue Bücher vor, die mir deshalb gefallen könnten. Regeln:
- Nur real existierende, im deutschsprachigen Handel erhältliche Bücher (Titel der deutschen Ausgabe, falls es eine gibt).
- Keines dieser Bücher, denn die kenne ich schon:
${alreadyKnown}
- Gerne eine Mischung aus naheliegenden Treffern und einer kleinen Überraschung.
- "reason": 2–3 Sätze auf Deutsch, warum das Buch zu meinen Favoriten passt (beziehe dich konkret auf sie).
- "year": Erscheinungsjahr des Originals, "genre": kurzes Genre-Stichwort.
${wish ? `\nMeine Wünsche: ${wish}` : ''}`,
    });
    const known = new Set([...books, ...wishlist].map((b) => norm(b.title)));
    lastRecos = res.recommendations.filter((r) => !known.has(norm(r.title))).slice(0, 5);
    busy('Cover werden geladen …');
    await Promise.all(lastRecos.map(async (r) => { r.cover = await findCover(r.title, r.author); }));
    busy();
    renderRecos();
    $('#recoResult').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    busy();
    toast(err.message);
    if (err.noKey) showView('settings');
  }
});

// ---------- Einstellungen ----------
$('#apiKey').value = settings.apiKey;
$('#model').value = settings.model;
$('#saveSettings').addEventListener('click', () => {
  settings = { apiKey: $('#apiKey').value.trim(), model: $('#model').value };
  store.set('settings', settings);
  toast('Einstellungen gespeichert');
});

$('#exportBtn').addEventListener('click', async () => {
  const json = JSON.stringify({ books, wishlist, exported: new Date().toISOString() }, null, 2);
  const file = new File([json], `leseliste-${today()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch { /* abgebrochen */ }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
  }
});
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.books)) throw new Error();
    if (!confirm(`${data.books.length} Bücher importieren? Die aktuelle Liste wird ersetzt.`)) return;
    books = data.books; wishlist = data.wishlist || [];
    saveBooks(); saveWishlist(); renderLibrary();
    toast('Import erfolgreich');
  } catch { toast('Die Datei ist kein gültiges Backup.'); }
});

// ---------- Start ----------
renderLibrary();
fillMissingCovers();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
