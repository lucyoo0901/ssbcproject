'use strict';
/* =========================================================
   2026 성도교제밤 촬영일자
   - 일정 데이터: 저장소의 data.json (모두가 읽음)
   - 관리자 저장: GitHub API로 data.json / images/* 에 직접 커밋

   data.json 구조
   - cast / staff : [{ id, role, name }]
   - locations    : [{ id, name, address, lat, lng, memo, photos:[{src,cap}] }]
   - items        : [{ id, name, owner }]          ← 준비물 목록
   - events       : [{ id, date, type, title, start, end, locationId, people:[], extra, memo,
                       items:[itemId], done:{ itemId:true }, scenes:[...] }]
   - scene        : { id, time, no, title, desc, locationId, cast:[], items:[itemId], images:[{src,cap}] }
   - links        : { script, storyboard }
   ========================================================= */

/* ---------- 설정 ---------- */
const RANGE_START = '2026-11-01';
const RANGE_END = '2026-12-31';
const MONTHS = [{ y: 2026, m: 10 }, { y: 2026, m: 11 }]; // m: 0부터 시작 (10 = 11월)
const TYPES = [
  { key: '촬영', cls: 'shoot' },
  { key: '편집', cls: 'edit' },
  { key: '회의', cls: 'meet' },
  { key: '기타', cls: 'etc' },
];
const HOLIDAYS = { '2026-12-25': '성탄절' };
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const VIEW_TITLES = { board: '촬영 스케줄', people: '촬영 인원', locations: '촬영 장소', supplies: '준비물', script: '대본', storyboard: '스토리보드' };

/* ---------- 상태 ---------- */
const state = {
  data: null,
  mi: 0,              // 보고 있는 달 (MONTHS 인덱스)
  view: 'calendar',   // calendar | people | locations | supplies | script | storyboard
  supTab: 'event',    // 준비물 화면: event(일정별) | catalog(준비물 목록)
  openDate: null,     // 서랍에 열린 날짜
  viewer: null,       // { kind:'scene', evId, sceneId } | { kind:'loc', id, back }
  lightbox: null,     // { images:[{src,cap}], idx }
  admin: false,
  localOnly: false,   // 토큰 없이 임시 편집
  gh: null,           // { token, owner, repo, branch }
  sha: null,
  dirty: false,
  imgCache: {},       // 방금 올린 이미지 (Pages 반영 전 미리보기용)
};

/* ---------- 유틸 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = (k) => { const d = parseKey(k); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`; };
const fmtShort = (k) => { const d = parseKey(k); return `${d.getMonth() + 1}/${d.getDate()}`; };
const inRange = (k) => k >= RANGE_START && k <= RANGE_END;
const todayKey = keyOf(new Date());
const typeCls = (t) => (TYPES.find((x) => x.key === t) || TYPES[3]).cls;
const imgSrc = (s) => state.imgCache[s] || s;
const byTime = (a, b) => (a || '').localeCompare(b || '');
const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
function hashId(prefix, s) {
  let h = 5381;
  for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return prefix + h.toString(36);
}

const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* 무시 */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* 무시 */ } },
};

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- 데이터 (예전 형식도 자동 변환) ---------- */
const normImages = (arr) => (Array.isArray(arr) ? arr : []).map((im) => (typeof im === 'string' ? { src: im, cap: '' } : im));

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  for (const k of ['cast', 'staff', 'events', 'locations', 'items']) if (!Array.isArray(d[k])) d[k] = [];
  d.links = d.links && typeof d.links === 'object' ? d.links : {};
  d.locations.forEach((l) => {
    l.id ||= uid();
    for (const f of ['name', 'address', 'lat', 'lng', 'memo']) l[f] ??= '';
    l.photos = normImages(l.photos);
  });
  d.items.forEach((it) => { it.id ||= uid(); it.name ??= ''; it.owner ??= ''; });

  // 예전의 '장소 글자' → 장소 목록으로 (띄어쓰기만 다른 이름은 같은 장소로 봄)
  const locFor = (name) => {
    if (!name || !String(name).trim()) return '';
    let l = d.locations.find((x) => norm(x.name) === norm(name));
    if (!l) {
      l = { id: hashId('loc-', norm(name)), name: String(name).trim(), address: '', lat: '', lng: '', memo: '', photos: [] };
      d.locations.push(l);
    }
    return l.id;
  };
  // 예전의 '준비물 항목' → 준비물 목록으로 (이름+담당이 같으면 하나로 합침)
  const itemFor = (it) => {
    if (typeof it === 'string') return it;
    const key = `${norm(it.name)}|${norm(it.owner)}`;
    let c = d.items.find((x) => `${norm(x.name)}|${norm(x.owner)}` === key);
    if (!c) {
      c = { id: hashId('it-', key), name: String(it.name || '').trim(), owner: String(it.owner || '').trim() };
      d.items.push(c);
    }
    return c.id;
  };

  d.events.forEach((e) => {
    e.id ||= uid();
    e.people ||= [];
    e.scenes ||= [];
    e.done = e.done && typeof e.done === 'object' ? e.done : {};
    if (e.locationId === undefined) { e.locationId = locFor(e.location); delete e.location; }
    if (!Array.isArray(e.items)) e.items = [];
    if (Array.isArray(e.supplies)) {
      e.supplies.forEach((it) => {
        const id = itemFor(it);
        if (!e.items.includes(id)) e.items.push(id);
        if (it.done) e.done[id] = true;
      });
      delete e.supplies;
    }
    e.scenes.forEach((s) => {
      s.id ||= uid();
      s.cast ||= [];
      s.images = normImages(s.images);
      if (s.locationId === undefined) { s.locationId = locFor(s.location); delete s.location; }
      if (!Array.isArray(s.items)) s.items = [];
      if (Array.isArray(s.props)) {
        s.props.forEach((it) => {
          const id = itemFor(it);
          if (!s.items.includes(id)) s.items.push(id);
          if (it.done) e.done[id] = true;
        });
        delete s.props;
      }
    });
  });
  return d;
}

async function loadData() {
  try {
    const r = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    state.data = normalize(await r.json());
  } catch {
    state.data = normalize({});
    toast('data.json을 불러오지 못해 빈 일정으로 표시합니다.');
  }
}

const findEv = (id) => state.data.events.find((e) => e.id === id);
const findLoc = (id) => (id ? state.data.locations.find((l) => l.id === id) : null);
const findCat = (id) => state.data.items.find((x) => x.id === id);
const eventsOn = (k) => state.data.events.filter((e) => e.date === k).sort((a, b) => byTime(a.start, b.start));
const sortScenes = (ev) => [...ev.scenes].sort((a, b) => byTime(a.time, b.time));
const sortedEvents = () => [...state.data.events].sort((a, b) => byTime(a.date + a.start, b.date + b.start));
function findPerson(id) {
  const c = state.data.cast.find((p) => p.id === id);
  if (c) return { ...c, kind: 'cast' };
  const s = state.data.staff.find((p) => p.id === id);
  return s ? { ...s, kind: 'staff' } : null;
}
const pchip = (p) => `<span class="pchip ${p.kind}">${esc(p.name || '(미정)')}<small>${esc(p.role)}</small></span>`;
function datesOf(id) {
  const set = new Set();
  state.data.events.forEach((e) => {
    if (e.people.includes(id) || e.scenes.some((s) => s.cast.includes(id))) set.add(e.date);
  });
  return [...set].sort();
}

/* 장소 */
const sceneLocId = (e, s) => s.locationId || e.locationId;
const locChanged = (e, s) => !!(s.locationId && s.locationId !== e.locationId);
function locUsage(id) {
  const out = [];
  sortedEvents().forEach((e) => {
    const scenes = sortScenes(e).filter((s) => sceneLocId(e, s) === id);
    if (e.locationId === id || scenes.length) out.push({ e, scenes });
  });
  return out;
}
function mapLinks(l) {
  const hasXY = l.lat !== '' && l.lng !== '' && !isNaN(+l.lat) && !isNaN(+l.lng);
  const q = hasXY ? `${l.lat},${l.lng}` : (l.address || '');
  const term = encodeURIComponent(l.address || l.name);
  return {
    hasXY,
    embed: q ? `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=16&output=embed` : '',
    kakao: hasXY
      ? `https://map.kakao.com/link/map/${encodeURIComponent(l.name)},${l.lat},${l.lng}`
      : `https://map.kakao.com/link/search/${term}`,
    naver: `https://map.naver.com/p/search/${term}`,
    google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q || l.name)}`,
  };
}

/* 준비물: 일정 공통 + 씬별을 품목 하나로 합쳐서 */
function suppliesOf(e) {
  const map = new Map();
  const add = (id, tag) => {
    const it = findCat(id);
    if (!it) return;
    if (!map.has(id)) map.set(id, { it, tags: [], key: `${e.id}|${id}`, done: !!e.done[id] });
    const m = map.get(id);
    if (!m.tags.includes(tag)) m.tags.push(tag);
  };
  e.items.forEach((id) => add(id, '공통'));
  sortScenes(e).forEach((s) => s.items.forEach((id) => add(id, s.no || '씬')));
  return [...map.values()];
}
function itemUsage(id) {
  return sortedEvents().map((e) => {
    const tags = [];
    if (e.items.includes(id)) tags.push('공통');
    sortScenes(e).forEach((s) => { if (s.items.includes(id)) tags.push(s.no || '씬'); });
    return { e, tags };
  }).filter((x) => x.tags.length);
}
function suppliesListHTML(list, showTags = true) {
  return `<ul class="supplies">${list.map((x) => `
    <li class="${x.done ? 'done' : ''}">
      ${state.admin
        ? `<button class="chk" data-toggle="${x.key}" aria-pressed="${x.done}" aria-label="${esc(x.it.name)} 준비 완료 표시">${x.done ? '✓' : ''}</button>`
        : `<span class="chk" aria-hidden="true">${x.done ? '✓' : ''}</span>`}
      <span class="it-n">${esc(x.it.name)}</span>
      ${x.it.owner ? `<span class="it-o">${esc(x.it.owner)}</span>` : ''}
      ${showTags ? `<span class="it-tags">${x.tags.map((t) => `<span class="it-tag">${esc(t)}</span>`).join('')}</span>` : ''}
    </li>`).join('')}</ul>`;
}

/* 문서 링크 → 화면에 넣을 수 있는 주소로 변환 */
function embedUrl(u) {
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.hostname === 'docs.google.com') {
    if (url.pathname.includes('/d/e/')) { // '웹에 게시' 주소
      if (url.pathname.startsWith('/presentation/')) url.pathname = url.pathname.replace(/\/pub$/, '/embed');
      else url.searchParams.set('embedded', 'true');
      return url.toString();
    }
    const m = url.pathname.match(/^\/(document|presentation|spreadsheets)\/d\/([^/]+)/);
    if (m) return `https://docs.google.com/${m[1]}/d/${m[2]}/preview`;
  }
  if (url.hostname === 'drive.google.com') {
    const m = url.pathname.match(/\/file\/d\/([^/]+)/);
    if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  }
  return url.toString();
}

function markDirty() {
  state.dirty = true;
  const b = $('[data-act="save"]');
  if (b) b.disabled = false;
}

function ensureMonth(k) {
  const d = parseKey(k);
  const i = MONTHS.findIndex((x) => x.y === d.getFullYear() && x.m === d.getMonth());
  if (i >= 0) state.mi = i;
}

/* ---------- GitHub 연동 ---------- */
async function gh(path, opts = {}) {
  const { token, owner, repo } = state.gh;
  const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const err = new Error(j.message || r.statusText);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}
function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

function guessRepo() {
  const h = location.hostname;
  if (h.endsWith('.github.io')) {
    const owner = h.split('.')[0];
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return `${owner}/${seg && !seg.includes('.') ? seg : `${owner}.github.io`}`;
  }
  try {
    const saved = JSON.parse(store.get('gh') || 'null');
    if (saved) return `${saved.owner}/${saved.repo}`;
  } catch { /* 무시 */ }
  return '';
}

async function login(token, repoStr) {
  const [owner, repo] = repoStr.split('/').map((s) => (s || '').trim());
  if (!owner || !repo) throw new Error('저장소를 "아이디/저장소이름" 형식으로 입력해 주세요.');
  state.gh = { token: token.trim(), owner, repo };
  try {
    const info = await gh('');
    if (info.permissions && !info.permissions.push) throw new Error('이 계정은 저장소에 쓰기 권한이 없습니다.');
    state.gh.branch = info.default_branch;
    try {
      const f = await gh(`/contents/data.json?ref=${encodeURIComponent(state.gh.branch)}`);
      state.data = normalize(JSON.parse(b64dec(f.content)));
      state.sha = f.sha;
    } catch (e) {
      if (e.status === 404) state.sha = null; else throw e;
    }
  } catch (e) {
    state.gh = null;
    if (e.status === 401) throw new Error('토큰이 올바르지 않거나 만료되었습니다.');
    if (e.status === 404) throw new Error('저장소를 찾을 수 없습니다. 이름과 토큰의 저장소 접근 권한을 확인해 주세요.');
    throw e;
  }
  store.set('gh', JSON.stringify(state.gh));
  state.admin = true;
  state.localOnly = false;
  state.dirty = false;
}

async function save() {
  if (state.localOnly) { downloadJson(); return; }
  const btn = $('[data-act="save"]');
  if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }
  const body = {
    message: `촬영 일정 수정 (${new Date().toLocaleString('ko-KR')})`,
    content: b64enc(JSON.stringify(state.data, null, 2) + '\n'),
    branch: state.gh.branch,
  };
  if (state.sha) body.sha = state.sha;
  try {
    const r = await gh('/contents/data.json', { method: 'PUT', body: JSON.stringify(body) });
    state.sha = r.content.sha;
    state.dirty = false;
    render();
    toast('저장했습니다. 사이트에 반영되기까지 1~5분 걸릴 수 있습니다.', 5000);
  } catch (e) {
    render();
    showSaveError(e);
  }
}

function showSaveError(e) {
  const reasons = {
    401: ['토큰이 올바르지 않거나 만료되었습니다.', '‘나가기’ 후 토큰을 새로 만들어 다시 로그인해 주세요.'],
    403: ['토큰에 저장(쓰기) 권한이 없습니다.',
      '클래식 토큰은 <b>public_repo</b>를 체크해야 하고, Fine-grained 토큰은 <b>Contents: Read and write</b> 권한이 있어야 합니다. 권한을 고친 뒤 다시 ‘저장’을 눌러 주세요.'],
    404: ['저장소를 찾을 수 없습니다.', '로그인할 때 넣은 저장소 이름과 토큰의 저장소 접근 범위를 확인해 주세요.'],
    409: ['다른 곳에서 먼저 수정되었습니다.', '지금 고친 내용을 메모해 두고, ‘나가기’ 후 다시 로그인해서 고쳐 주세요.'],
    422: ['다른 곳에서 먼저 수정되었습니다.', '지금 고친 내용을 메모해 두고, ‘나가기’ 후 다시 로그인해서 고쳐 주세요.'],
  };
  const [title, fix] = reasons[e.status] || (e.status
    ? ['저장하지 못했습니다.', '잠시 후 다시 ‘저장’을 눌러 주세요.']
    : ['인터넷 연결을 확인해 주세요.', '연결된 뒤 다시 ‘저장’을 눌러 주세요.']);
  openModal(`
    <div class="m-head"><h2>⚠️ ${title}</h2><button type="button" class="icon-btn" data-act="close-modal" aria-label="닫기">✕</button></div>
    <div class="m-body">
      <p style="margin:0">${fix}</p>
      <p class="hint">수정한 내용은 아직 이 화면에 남아 있습니다. 창을 닫지 마세요.</p>
      <p class="hint">GitHub 응답: ${e.status || '-'} ${esc(e.message)}</p>
    </div>
    <div class="m-foot">
      <button type="button" class="btn" data-act="download-json">data.json 내려받기 (백업)</button>
      <button type="button" class="btn primary" data-act="close-modal">확인</button>
    </div>`);
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(state.data, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'data.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  if (state.localOnly) {
    state.dirty = false; // 내려받은 파일이 곧 저장본
    render();
    openModal(`
      <div class="m-head"><h2>data.json을 내려받았습니다</h2><button type="button" class="icon-btn" data-act="close-modal" aria-label="닫기">✕</button></div>
      <div class="m-body">
        <p style="margin:0"><b>지금은 ‘임시 편집’ 모드라서 사이트에는 아직 반영되지 않았습니다.</b></p>
        <p style="margin:0">GitHub 저장소에서 <b>Add file → Upload files</b>로 방금 받은 data.json을 올리면 반영됩니다.</p>
        <p class="hint">바로 저장되게 하려면 ‘나가기’ 후 ✎ 수정에서 GitHub 토큰으로 로그인해 주세요.</p>
      </div>
      <div class="m-foot"><button type="button" class="btn primary" data-act="close-modal">확인</button></div>`);
  } else {
    toast('백업용 data.json을 내려받았습니다.');
  }
}

function compress(file, max = 1600, q = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', q));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다.')); };
    img.src = url;
  });
}

async function uploadImage(dataUrl, folder = 'scenes') {
  const path = `images/${folder}/${Date.now()}-${uid()}.jpg`;
  await gh(`/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message: '이미지 추가', content: dataUrl.split(',')[1], branch: state.gh.branch }),
  });
  return path;
}

/* ---------- 렌더링 ---------- */
function render() {
  document.body.classList.toggle('is-admin', state.admin);
  hideHoverCard();
  renderSide();
  const body = {
    calendar: calendarHTML, board: boardHTML, people: peopleHTML, locations: locationsHTML, supplies: suppliesPageHTML,
    script: () => docHTML('script'), storyboard: () => docHTML('storyboard'),
  }[state.view] || calendarHTML;
  $('#main').innerHTML = topbarHTML() + body();
  renderDrawer();
  renderViewer();
  renderLightbox();
}

function renderSide() {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  const list = sortedEvents().filter((e) => e.type === '촬영');
  $('#upcoming').innerHTML = list.length
    ? list.map((e) => `
      <button class="up-item ${e.date < todayKey ? 'past' : ''}" data-goto="${e.date}">
        <span class="up-date">${fmtShort(e.date)}<small>${WEEK[parseKey(e.date).getDay()]}</small></span>
        <span class="up-txt">${esc(e.title || '촬영')}<small>${esc(e.start)}${e.end ? `–${esc(e.end)}` : ''} · ${e.scenes.length}씬</small></span>
      </button>`).join('')
    : '<div class="empty sm">아직 촬영 일정이 없습니다.</div>';
}

function topbarHTML() {
  const { y, m } = MONTHS[state.mi];
  const left = state.view === 'calendar'
    ? `<button class="btn" data-act="today">오늘</button>
       <button class="icon-btn" data-act="prev" ${state.mi === 0 ? 'disabled' : ''} aria-label="이전 달">‹</button>
       <button class="icon-btn" data-act="next" ${state.mi === MONTHS.length - 1 ? 'disabled' : ''} aria-label="다음 달">›</button>
       <h1 class="month-title">${y}년 ${m + 1}월</h1>`
    : `<h1 class="month-title">${VIEW_TITLES[state.view]}</h1>`;
  const isDoc = state.view === 'script' || state.view === 'storyboard';
  const link = isDoc ? state.data.links[state.view] : '';
  const tools = isDoc
    ? `${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">새 창에서 열기 ↗</a>` : ''}
       ${state.admin ? '<button class="btn" data-act="set-link">링크 설정</button>' : ''}`
    : state.view === 'locations' && state.admin ? '<button class="btn" data-act="add-loc">+ 장소 추가</button>' : '';
  const right = tools + (state.admin
    ? `<span class="mode admin">${state.localOnly ? '임시 편집 · 사이트 저장 안 됨' : '관리자'}</span>
       <button class="btn primary" data-act="save" ${state.dirty || state.localOnly ? '' : 'disabled'}>${state.localOnly ? 'data.json 받기' : '저장'}</button>
       <button class="btn" data-act="logout">나가기</button>`
    : `<span class="mode">보기 전용</span>
       <button class="btn" data-act="login">✎ 수정</button>`);
  return `<header class="topbar"><div class="tb-left">${left}</div><div class="tb-right">${right}</div></header>`;
}

const chipHTML = (e) => `
  <div class="chip t-${typeCls(e.type)}"><span class="chip-time">${esc(e.start || '')}</span><span class="chip-title">${esc(e.title || e.type)}</span></div>`;

function calendarHTML() {
  const { y, m } = MONTHS[state.mi];
  const start = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const total = Math.ceil((start + days) / 7) * 7;
  let cells = '';
  for (let i = 0; i < total; i++) {
    const d = new Date(y, m, 1 - start + i);
    const k = keyOf(d);
    const dow = d.getDay();
    const ok = inRange(k);
    const hol = HOLIDAYS[k];
    const evs = eventsOn(k);
    const cls = ['day',
      d.getMonth() !== m && 'out',
      !ok && 'disabled',
      k === todayKey && 'today',
      (dow === 0 || hol) && 'sun',
      dow === 6 && 'sat',
      evs.some((e) => e.type === '촬영') && 'has-shoot',
    ].filter(Boolean).join(' ');
    const attrs = ok ? `data-day="${k}" tabindex="0" role="button" aria-label="${fmtDate(k)}, 일정 ${evs.length}개"` : '';
    cells += `
      <div class="${cls}" ${attrs}>
        <div class="day-head">
          <span class="num">${d.getDate() === 1 ? `${d.getMonth() + 1}월 ` : ''}${d.getDate()}</span>
          ${hol ? `<span class="hol">${hol}</span>` : ''}
          ${state.admin && ok ? `<button class="add-btn" data-add="${k}" aria-label="${fmtDate(k)}에 일정 추가">+</button>` : ''}
        </div>
        <div class="chips">${evs.slice(0, 3).map(chipHTML).join('')}${evs.length > 3 ? `<div class="more">+${evs.length - 3}개</div>` : ''}</div>
      </div>`;
  }
  return `
    <div class="cal">
      <div class="weekdays">${WEEK.map((w, i) => `<div class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}</div>
      <div class="grid" style="--rows:${total / 7}">${cells}</div>
    </div>`;
}

const locLink = (id, cls = '') => {
  const l = findLoc(id);
  return l ? `<button class="loc-link ${cls}" data-loc="${l.id}">📍 ${esc(l.name)}</button>` : '';
};

function eventCardHTML(e) {
  const people = e.people.map(findPerson).filter(Boolean);
  const scenes = sortScenes(e);
  const supplies = suppliesOf(e);
  const showScenes = scenes.length || state.admin;
  return `
    <article class="ev-card t-${typeCls(e.type)}">
      <div class="ev-top">
        <span class="badge">${esc(e.type)}</span>
        <span class="ev-time">${esc(e.start)}${e.end ? ` – ${esc(e.end)}` : ''}</span>
        ${state.admin ? `<span class="ev-tools"><button class="mini" data-edit-ev="${e.id}">수정</button><button class="mini danger" data-del-ev="${e.id}">삭제</button></span>` : ''}
      </div>
      <h3>${esc(e.title || e.type)}</h3>
      ${e.locationId ? `<div class="ev-meta">${locLink(e.locationId)}</div>` : ''}
      ${people.length || e.extra ? `<div class="pchips">${people.map(pchip).join('')}${e.extra ? `<span class="pchip">${esc(e.extra)}</span>` : ''}</div>` : ''}
      ${e.memo ? `<p class="ev-memo">${esc(e.memo)}</p>` : ''}
      ${showScenes ? `
        <div class="scenes">
          <div class="scenes-h"><span>씬 스케줄</span>${state.admin ? `<button class="mini" data-add-scene="${e.id}">+ 씬 추가</button>` : ''}</div>
          ${scenes.map((s) => {
            const moved = locChanged(e, s);
            const sub = [moved ? `📍 ${esc(findLoc(s.locationId)?.name)}` : '', esc(s.desc)].filter(Boolean).join(' · ');
            return `
            <div class="scene-row">
              <button class="scene-main ${moved ? 'moved' : ''}" data-scene="${e.id}|${s.id}" aria-label="${esc(s.no)} ${esc(s.title)} 콘티 보기">
                <span class="s-time">${esc(s.time || '')}</span>
                <span class="s-no">${esc(s.no || '')}</span>
                <span class="s-title">${esc(s.title || '제목 없음')}${sub ? `<small>${sub}</small>` : ''}</span>
                <span class="s-img">${s.images.length ? `🖼 ${s.images.length}` : ''}</span>
              </button>
              ${state.admin ? `<button class="mini" data-edit-scene="${e.id}|${s.id}" aria-label="씬 수정">✎</button>` : ''}
            </div>`;
          }).join('')}
          ${scenes.length ? '' : '<div class="empty sm">씬을 추가해 주세요.</div>'}
        </div>` : ''}
      ${supplies.length ? `
        <div class="scenes">
          <div class="scenes-h"><span>준비물</span><span>${supplies.filter((x) => x.done).length} / ${supplies.length} 준비됨</span></div>
          ${suppliesListHTML(supplies)}
        </div>` : ''}
    </article>`;
}

function renderDrawer() {
  const dr = $('#drawer');
  const k = state.openDate;
  $('#scrim').classList.toggle('show', !!k);
  if (!k) { dr.classList.remove('open'); dr.setAttribute('aria-hidden', 'true'); return; }
  const scroll = $('.drawer-body', dr)?.scrollTop || 0;
  const evs = eventsOn(k);
  dr.innerHTML = `
    <div class="drawer-head">
      <div><div class="dh-sub">${HOLIDAYS[k] || '일정 상세'}</div><h2>${fmtDate(k)}</h2></div>
      <button class="icon-btn" data-act="close-day" aria-label="닫기">✕</button>
    </div>
    <div class="drawer-body">
      ${state.admin ? `<button class="btn primary block" data-add="${k}">+ 일정 추가</button>` : ''}
      ${evs.length ? evs.map(eventCardHTML).join('') : '<div class="empty">등록된 일정이 없습니다.</div>'}
    </div>`;
  dr.classList.add('open');
  dr.setAttribute('aria-hidden', 'false');
  $('.drawer-body', dr).scrollTop = scroll;
}

/* ---------- 전체 화면 보기 (씬 콘티 / 장소) ---------- */
function renderViewer() {
  const v = $('#viewer');
  const st = state.viewer;
  if (!st) { v.classList.remove('open'); v.innerHTML = ''; return; }
  const keepScroll = $('#vScroll')?.scrollTop || 0;
  const html = st.kind === 'loc' ? locViewerHTML(st) : sceneViewerHTML(st);
  if (html === null) { state.viewer = null; renderViewer(); return; }
  v.innerHTML = html;
  v.classList.add('open');
  $('#vScroll').scrollTop = keepScroll;
}

function sceneViewerHTML(st) {
  const ev = findEv(st.evId);
  const scenes = ev ? sortScenes(ev) : [];
  const si = scenes.findIndex((s) => s.id === st.sceneId);
  if (si < 0) return null;
  const s = scenes[si];
  const imgs = s.images;
  const cast = s.cast.map(findPerson).filter(Boolean);
  const locId = sceneLocId(ev, s);
  const items = s.items.map(findCat).filter(Boolean).map((it) => ({ it, tags: [], key: `${ev.id}|${it.id}`, done: !!ev.done[it.id] }));
  const prev = scenes[si - 1];
  const next = scenes[si + 1];
  return `
    <div class="v-scroll" id="vScroll">
      <header class="v-top">
        <div class="v-top-in">
          <div class="v-head">
            <div class="v-sub">${fmtDate(ev.date)} · ${esc(ev.title || ev.type)}${s.time ? ` · ${esc(s.time)}` : ''}</div>
            <h2><span class="v-no">${esc(s.no || '')}</span> ${esc(s.title || '')}</h2>
          </div>
          ${imgs.length > 1 ? `<nav class="v-jump" aria-label="컷 바로가기">${imgs.map((_, j) => `<button data-vjump="${j}">${j + 1}</button>`).join('')}</nav>` : ''}
          <button class="icon-btn light" data-act="close-viewer" aria-label="닫기">✕</button>
        </div>
      </header>
      <div class="v-body">
        <section class="v-info">
          ${locId ? `<div class="v-row"><span class="v-k">장소</span><span>${locLink(locId, 'light')}${locChanged(ev, s) ? ' <small>(일정 장소와 다름)</small>' : ''}</span></div>` : ''}
          ${s.desc ? `<div class="v-row"><span class="v-k">내용</span><span class="v-desc">${esc(s.desc)}</span></div>` : ''}
          ${cast.length ? `<div class="v-row"><span class="v-k">배역</span><div class="pchips">${cast.map(pchip).join('')}</div></div>` : ''}
          ${items.length ? `<div class="v-row"><span class="v-k">준비물</span>${suppliesListHTML(items, false)}</div>` : ''}
        </section>
        ${imgs.length
          ? imgs.map((im, j) => `
            <figure class="v-cut" id="vcut-${j}">
              <figcaption><span class="cut-no">컷 ${j + 1}</span>${im.cap ? `<span>${esc(im.cap)}</span>` : ''}<span class="cut-of">${j + 1} / ${imgs.length}</span></figcaption>
              <img src="${esc(imgSrc(im.src))}" alt="${esc(s.no)} 컷 ${j + 1}${im.cap ? ` ${esc(im.cap)}` : ''}" loading="lazy">
            </figure>`).join('')
          : '<div class="v-empty">아직 등록된 콘티 이미지가 없습니다.</div>'}
        <footer class="v-nav">
          <button class="btn ghost" data-vscene="${prev ? prev.id : ''}" ${prev ? '' : 'disabled'}>‹ ${prev ? `${esc(prev.no || '이전 씬')} ${esc(prev.title || '')}` : '처음 씬'}</button>
          <span class="v-pos">씬 ${si + 1} / ${scenes.length}</span>
          <button class="btn ghost" data-vscene="${next ? next.id : ''}" ${next ? '' : 'disabled'}>${next ? `${esc(next.no || '다음 씬')} ${esc(next.title || '')}` : '마지막 씬'} ›</button>
        </footer>
      </div>
    </div>`;
}

function locViewerHTML(st) {
  const l = findLoc(st.id);
  if (!l) return null;
  const mp = mapLinks(l);
  const usage = locUsage(l.id);
  return `
    <div class="v-scroll" id="vScroll">
      <header class="v-top">
        <div class="v-top-in">
          ${st.back ? '<button class="btn ghost light" data-act="viewer-back">‹ 씬으로</button>' : ''}
          <div class="v-head">
            <div class="v-sub">촬영 장소</div>
            <h2>📍 ${esc(l.name)}</h2>
          </div>
          ${state.admin ? `<button class="btn ghost light" data-edit-loc="${l.id}">수정</button>` : ''}
          <button class="icon-btn light" data-act="close-viewer" aria-label="닫기">✕</button>
        </div>
      </header>
      <div class="v-body">
        <section class="v-info">
          ${l.address ? `<div class="v-row"><span class="v-k">주소</span><span>${esc(l.address)}</span></div>` : ''}
          ${mp.hasXY ? `<div class="v-row"><span class="v-k">좌표</span><span>${esc(l.lat)}, ${esc(l.lng)}</span></div>` : ''}
          ${l.memo ? `<div class="v-row"><span class="v-k">메모</span><span class="v-desc">${esc(l.memo)}</span></div>` : ''}
          <div class="v-row"><span class="v-k">지도</span><span class="map-links">
            <a class="btn ghost light sm" href="${mp.kakao}" target="_blank" rel="noopener noreferrer">카카오맵 ↗</a>
            <a class="btn ghost light sm" href="${mp.naver}" target="_blank" rel="noopener noreferrer">네이버 지도 ↗</a>
            <a class="btn ghost light sm" href="${mp.google}" target="_blank" rel="noopener noreferrer">구글 지도 ↗</a>
          </span></div>
          ${usage.length ? `<div class="v-row"><span class="v-k">촬영</span><span class="use-list">${usage.map(({ e, scenes }) => `
            <span class="use-item"><button class="date-chip" data-goto="${e.date}">${fmtShort(e.date)}</button>
            ${scenes.map((s) => `<button class="use-scene" data-scene="${e.id}|${s.id}">${esc(s.no || '씬')} ${esc(s.title)}</button>`).join('')}</span>`).join('')}</span></div>` : ''}
        </section>
        ${mp.embed ? `<iframe class="v-map" src="${esc(mp.embed)}" title="${esc(l.name)} 지도" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>` : ''}
        <section>
          <h3 class="g-title">사진 ${l.photos.length}장</h3>
          ${l.photos.length
            ? `<div class="gallery">${l.photos.map((p, j) => `
              <button class="g-item" data-lb="${j}" aria-label="사진 ${j + 1} 크게 보기">
                <img src="${esc(imgSrc(p.src))}" alt="${esc(p.cap || `${l.name} 사진 ${j + 1}`)}" loading="lazy">
                ${p.cap ? `<span>${esc(p.cap)}</span>` : ''}
              </button>`).join('')}</div>`
            : `<div class="v-empty">${state.admin ? '‘수정’을 눌러 사진을 추가해 주세요.' : '아직 등록된 사진이 없습니다.'}</div>`}
        </section>
      </div>
    </div>`;
}

function renderLightbox() {
  const lb = $('#lightbox');
  const st = state.lightbox;
  if (!st) { lb.classList.remove('open'); lb.innerHTML = ''; return; }
  const n = st.images.length;
  st.idx = (st.idx + n) % n;
  const im = st.images[st.idx];
  lb.innerHTML = `
    <button class="icon-btn light lb-close" data-act="close-lb" aria-label="닫기">✕</button>
    <button class="lb-arrow left" data-lbi="${st.idx - 1}" aria-label="이전 사진" ${n < 2 ? 'hidden' : ''}>‹</button>
    <figure><img src="${esc(imgSrc(im.src))}" alt="${esc(im.cap || '')}"><figcaption>${st.idx + 1} / ${n}${im.cap ? ` · ${esc(im.cap)}` : ''}</figcaption></figure>
    <button class="lb-arrow right" data-lbi="${st.idx + 1}" aria-label="다음 사진" ${n < 2 ? 'hidden' : ''}>›</button>`;
  lb.classList.add('open');
}

/* ---------- 촬영 스케줄 (촬영일만 모아 비교) ---------- */
function boardHTML() {
  const days = sortedEvents().filter((e) => e.type === '촬영');
  if (!days.length) {
    return '<div class="page"><div class="card"><div class="empty">아직 촬영 일정이 없습니다.</div></div></div>';
  }
  return `
    <div class="board-wrap">
      <p class="board-hint">씬에 마우스를 올리면 등장 배역과 준비물이 보이고, 누르면 콘티가 열립니다. 🚚는 장소 이동, ↩는 이미 갔던 장소로 다시 돌아가는 곳입니다.</p>
      <div class="board">${days.map(dayColHTML).join('')}</div>
    </div>`;
}

function dayColHTML(e) {
  const scenes = sortScenes(e);
  const seen = new Set();
  let prevLoc = null;
  let moves = 0;
  let revisits = 0;
  let body = '';
  scenes.forEach((s, i) => {
    const lid = sceneLocId(e, s) || '';
    if (i === 0 || lid !== prevLoc) {
      const revisit = i > 0 && lid && seen.has(lid);
      if (i > 0) moves++;
      if (revisit) revisits++;
      body += `
        <div class="b-loc ${i > 0 ? 'move' : ''} ${revisit ? 'revisit' : ''}">
          ${i > 0 ? '<span class="b-move" aria-label="장소 이동">🚚</span>' : ''}
          ${lid ? locLink(lid) : '<span class="hint">장소 미정</span>'}
          ${revisit ? '<span class="b-warn">↩ 재방문</span>' : ''}
        </div>`;
      seen.add(lid);
      prevLoc = lid;
    }
    body += sceneRowHTML(e, s);
  });
  const cuts = scenes.reduce((n, s) => n + s.images.length, 0);
  const castOrder = [];
  scenes.forEach((s) => s.cast.forEach((id) => { if (!castOrder.includes(id)) castOrder.push(id); }));
  return `
    <section class="bcol">
      <header class="bcol-head">
        <button class="date-chip" data-goto="${e.date}">${fmtShort(e.date)} (${WEEK[parseKey(e.date).getDay()]})</button>
        <h2>${esc(e.title || '촬영')}</h2>
        <div class="bcol-time">${esc(e.start)}${e.end ? ` – ${esc(e.end)}` : ''}</div>
        <div class="bstats">
          <span>씬 <b>${scenes.length}</b></span>
          <span>컷 <b>${cuts}</b></span>
          <span>장소 이동 <b>${moves}</b>회</span>
          <span>배역 <b>${castOrder.length}</b>명</span>
        </div>
        ${revisits ? `<div class="b-alert">↩ 이미 갔던 장소로 ${revisits}번 돌아갑니다. 씬 순서를 조정하면 이동을 줄일 수 있습니다.</div>` : ''}
      </header>
      <div class="bcol-body">${scenes.length ? body : '<div class="empty sm">등록된 씬이 없습니다.</div>'}</div>
      ${castOrder.length ? castGridHTML(scenes, castOrder) : ''}
    </section>`;
}

function sceneRowHTML(e, s) {
  const cast = s.cast.map(findPerson).filter(Boolean);
  const items = s.items.map(findCat).filter(Boolean);
  const loc = findLoc(sceneLocId(e, s));
  return `
    <div class="srow" data-srow="${e.id}|${s.id}" tabindex="0" role="button" aria-label="${esc(s.no)} ${esc(s.title)}, 등장 배역 ${cast.length}명, 준비물 ${items.length}개">
      <span class="s-time">${esc(s.time || '')}</span>
      <span class="s-no">${esc(s.no || '')}</span>
      <span class="sr-title">${esc(s.title || '제목 없음')}</span>
      <span class="sr-cuts" title="컷 ${s.images.length}개">🎞 ${s.images.length}</span>
      <div class="sdetail">
        <div class="hc-head"><b>${esc(s.no)} ${esc(s.title)}</b><span>${esc(s.time || '')}${loc ? ` · 📍 ${esc(loc.name)}` : ''} · 컷 ${s.images.length}</span></div>
        ${s.desc ? `<p class="hc-desc">${esc(s.desc)}</p>` : ''}
        <div class="hc-sec">
          <div class="hc-k">등장 배역 ${cast.length}</div>
          ${cast.length ? `<ul class="hc-list">${cast.map((p) => `<li><b>${esc(p.role)}</b><span>${esc(p.name || '미정')}</span></li>`).join('')}</ul>` : '<div class="hint">없음</div>'}
        </div>
        <div class="hc-sec">
          <div class="hc-k">준비물 ${items.length}</div>
          ${items.length ? `<ul class="hc-list">${items.map((it) => `<li><b>${esc(it.name)}</b><span>${esc(it.owner || '')}</span></li>`).join('')}</ul>` : '<div class="hint">없음</div>'}
        </div>
        <button class="mini hc-open" data-scene="${e.id}|${s.id}">콘티 보기 ›</button>
      </div>
    </div>`;
}

/* 배역 등장표: 누가 어느 씬에 나오는지, 첫 씬부터 마지막 씬까지 얼마나 머무는지 */
function castGridHTML(scenes, castOrder) {
  return `
    <details class="cast-grid" open>
      <summary>배역 등장 순서</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>배역</th>${scenes.map((s) => `<th title="${esc(s.title)}">${esc((s.no || '').replace(/^S#/, ''))}</th>`).join('')}<th>머무는 시간</th></tr></thead>
        <tbody>${castOrder.map((id) => {
          const p = findPerson(id);
          if (!p) return '';
          const idx = scenes.map((s, i) => (s.cast.includes(id) ? i : -1)).filter((i) => i >= 0);
          const first = idx[0];
          const last = idx[idx.length - 1];
          const lastScene = scenes[last];
          const span = `${esc(scenes[first].time)}–${esc(lastScene.time)}`;
          const gaps = last - first + 1 - idx.length;
          return `<tr>
            <td class="cg-name"><b>${esc(p.role)}</b><small>${esc(p.name)}</small></td>
            ${scenes.map((s, i) => `<td class="${s.cast.includes(id) ? 'on' : i > first && i < last ? 'wait' : ''}">${s.cast.includes(id) ? '●' : ''}</td>`).join('')}
            <td class="cg-span">${span}<small>${idx.length}씬${gaps ? ` · 대기 ${gaps}씬` : ''}</small></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      <p class="hint">● 출연 · 옅은 칸은 첫 출연과 마지막 출연 사이에 기다리는 씬입니다.</p>
    </details>`;
}

/* 마우스를 올리면 뜨는 상세 카드 */
const canHover = () => window.matchMedia('(hover: hover)').matches;
function showHoverCard(row) {
  const hc = $('#hovercard');
  if (hc.dataset.for === row.dataset.srow) return;
  hc.innerHTML = $('.sdetail', row).innerHTML;
  hc.dataset.for = row.dataset.srow;
  hc.classList.add('show');
  const r = row.getBoundingClientRect();
  const w = hc.offsetWidth;
  const h = hc.offsetHeight;
  let x = r.right + 10;
  if (x + w > innerWidth - 8) x = r.left - w - 10;
  if (x < 8) x = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const y = Math.max(8, Math.min(r.top - 8, innerHeight - h - 8));
  hc.style.left = `${x}px`;
  hc.style.top = `${y}px`;
}
function hideHoverCard() {
  const hc = $('#hovercard');
  hc.classList.remove('show');
  hc.dataset.for = '';
}
document.addEventListener('mouseover', (e) => {
  if (!canHover()) return;
  const row = e.target.closest?.('[data-srow]');
  if (row) showHoverCard(row);
});
document.addEventListener('mouseout', (e) => {
  const row = e.target.closest?.('[data-srow]');
  if (row && !row.contains(e.relatedTarget)) hideHoverCard();
});
document.addEventListener('focusin', (e) => { if (e.target.matches?.('[data-srow]') && canHover()) showHoverCard(e.target); });
document.addEventListener('focusout', (e) => { if (e.target.matches?.('[data-srow]')) hideHoverCard(); });
document.addEventListener('scroll', hideHoverCard, true);

/* ---------- 메뉴 화면들 ---------- */
function peopleHTML() {
  const section = (kind, title, roleLabel, nameLabel) => {
    const list = state.data[kind];
    const rows = list.map((p) => {
      const dates = datesOf(p.id).map((k) => `<button class="date-chip" data-goto="${k}">${fmtShort(k)}</button>`).join('');
      return state.admin
        ? `<tr>
            <td><input data-p="${kind}|${p.id}|role" value="${esc(p.role)}" placeholder="${roleLabel}" aria-label="${roleLabel}"></td>
            <td><input data-p="${kind}|${p.id}|name" value="${esc(p.name)}" placeholder="${nameLabel}" aria-label="${nameLabel}"></td>
            <td class="dates">${dates}</td>
            <td><button class="mini danger" data-del-p="${kind}|${p.id}" aria-label="삭제">✕</button></td>
          </tr>`
        : `<tr><td class="role">${esc(p.role)}</td><td>${esc(p.name || '미정')}</td><td class="dates">${dates || '<span class="hint">-</span>'}</td></tr>`;
    }).join('');
    return `
      <section class="card">
        <div class="card-head">
          <h2>${title}</h2><span class="count">${list.length}명</span>
          ${state.admin ? `<button class="btn sm" data-add-p="${kind}">+ 추가</button>` : ''}
        </div>
        ${list.length ? `
          <div class="table-wrap"><table class="ptable">
            <thead><tr><th>${roleLabel}</th><th>${nameLabel}</th><th>참여 일정</th>${state.admin ? '<th></th>' : ''}</tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`
        : `<div class="empty">${state.admin ? '‘+ 추가’를 눌러 등록해 주세요.' : '아직 등록된 인원이 없습니다.'}</div>`}
      </section>`;
  };
  return `<div class="people">${section('cast', '배역', '배역 이름', '배우')}${section('staff', '촬영 스태프', '역할', '이름')}</div>`;
}

function locationsHTML() {
  const list = state.data.locations;
  if (!list.length) {
    return `<div class="page"><div class="card"><div class="empty">${state.admin ? '오른쪽 위 ‘+ 장소 추가’로 촬영 장소를 등록해 주세요.' : '아직 등록된 촬영 장소가 없습니다.'}</div></div></div>`;
  }
  return `<div class="page"><div class="loc-grid">${list.map((l) => {
    const usage = locUsage(l.id);
    const sceneCount = usage.reduce((n, u) => n + u.scenes.length, 0);
    const cover = l.photos[0];
    return `
      <button class="loc-card" data-loc="${l.id}">
        <span class="loc-cover">${cover ? `<img src="${esc(imgSrc(cover.src))}" alt="" loading="lazy">` : '<span class="loc-ph" aria-hidden="true">📍</span>'}</span>
        <span class="loc-body">
          <b>${esc(l.name)}</b>
          <small>${esc(l.address || '주소 미입력')}</small>
          <span class="loc-meta">사진 ${l.photos.length} · 씬 ${sceneCount}${usage.length ? ` · ${usage.map((u) => fmtShort(u.e.date)).join(', ')}` : ''}</span>
        </span>
      </button>`;
  }).join('')}</div></div>`;
}

function suppliesPageHTML() {
  const tabs = `
    <div class="tabs" role="tablist">
      <button class="tab ${state.supTab === 'event' ? 'on' : ''}" data-suptab="event" role="tab" aria-selected="${state.supTab === 'event'}">일정별</button>
      <button class="tab ${state.supTab === 'catalog' ? 'on' : ''}" data-suptab="catalog" role="tab" aria-selected="${state.supTab === 'catalog'}">준비물 목록</button>
    </div>`;
  return `<div class="page">${tabs}${state.supTab === 'catalog' ? catalogHTML() : supByEventHTML()}</div>`;
}

function supByEventHTML() {
  const evs = sortedEvents().map((e) => ({ e, list: suppliesOf(e) })).filter((x) => x.list.length);
  if (!evs.length) {
    return `<div class="card"><div class="empty">${state.admin
      ? '일정이나 씬을 수정할 때 준비물을 고르면 여기에 날짜별로 모입니다.'
      : '아직 등록된 준비물이 없습니다.'}</div></div>`;
  }
  return `<div class="card-grid">${evs.map(({ e, list }) => {
    const done = list.filter((x) => x.done).length;
    return `
      <section class="card t-${typeCls(e.type)}">
        <div class="card-head">
          <button class="date-chip" data-goto="${e.date}">${fmtShort(e.date)} (${WEEK[parseKey(e.date).getDay()]})</button>
          <h2>${esc(e.title || e.type)}</h2>
          <span class="count ${done === list.length ? 'ok' : ''}">${done} / ${list.length}</span>
        </div>
        <div class="progress"><span style="width:${Math.round((done / list.length) * 100)}%"></span></div>
        ${suppliesListHTML(list)}
      </section>`;
  }).join('')}</div>`;
}

function catalogHTML() {
  const list = state.data.items;
  const rows = list.map((it) => {
    const use = itemUsage(it.id).map(({ e, tags }) => `
      <span class="use-item"><button class="date-chip" data-goto="${e.date}">${fmtShort(e.date)}</button><span class="hint">${tags.map(esc).join('·')}</span></span>`).join('');
    return state.admin
      ? `<tr>
          <td><input data-it="${it.id}|name" value="${esc(it.name)}" placeholder="품목" aria-label="품목"></td>
          <td><input data-it="${it.id}|owner" value="${esc(it.owner)}" placeholder="담당" aria-label="담당"></td>
          <td class="dates">${use}</td>
          <td><button class="mini danger" data-del-it="${it.id}" aria-label="삭제">✕</button></td>
        </tr>`
      : `<tr><td class="role">${esc(it.name)}</td><td>${esc(it.owner || '-')}</td><td class="dates">${use || '<span class="hint">-</span>'}</td></tr>`;
  }).join('');
  return `
    <section class="card">
      <div class="card-head">
        <h2>준비물 목록</h2><span class="count">${list.length}개</span>
        ${state.admin ? '<button class="btn sm" data-act="add-cat">+ 추가</button>' : ''}
      </div>
      <p class="hint" style="margin:0 0 8px">여기 등록한 품목을 일정·씬에서 골라 씁니다. 같은 품목은 일정 준비물에서 하나로 합쳐집니다.</p>
      ${list.length ? `
        <div class="table-wrap"><table class="ptable">
          <thead><tr><th>품목</th><th>담당</th><th>사용 일정 · 씬</th>${state.admin ? '<th></th>' : ''}</tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
      : `<div class="empty">${state.admin ? '‘+ 추가’를 눌러 등록해 주세요.' : '아직 등록된 준비물이 없습니다.'}</div>`}
    </section>`;
}

function docHTML(kind) {
  const label = VIEW_TITLES[kind];
  const url = state.data.links[kind];
  const src = url && embedUrl(url);
  return `<div class="doc">${src
    ? `<iframe src="${esc(src)}" title="${label}" loading="lazy" allow="fullscreen" referrerpolicy="no-referrer"></iframe>`
    : `<div class="empty">${state.admin
      ? `오른쪽 위 ‘링크 설정’에서 ${label} 문서 주소를 넣어 주세요.`
      : `아직 연결된 ${label} 문서가 없습니다.`}</div>`}</div>`;
}

/* ---------- 모달 ---------- */
function openModal(html) {
  $('#modal-root').innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  setTimeout(() => $('#modal-root input:not([type=hidden]):not([type=checkbox]), #modal-root select')?.focus(), 30);
}
function closeModal() { $('#modal-root').innerHTML = ''; }
const modalOpen = () => !!$('#modal-root').children.length;

/* 모달 공통 부품: 장소 선택 */
function locSelectHTML(name, selected, firstLabel) {
  return `
    <div class="loc-pick">
      <select name="${name}" id="sel-${name}" aria-label="장소 선택">
        <option value="">${esc(firstLabel)}</option>
        ${state.data.locations.map((l) => `<option value="${l.id}" ${l.id === selected ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select>
      <div class="new-row">
        <input data-new-loc-name="${name}" placeholder="목록에 없으면 새 장소 이름" aria-label="새 장소 이름">
        <button type="button" class="mini" data-new-loc="${name}">추가</button>
      </div>
    </div>`;
}
/* 모달 공통 부품: 준비물 고르기 */
const itemChip = (box, it, on) => `
  <label class="pick"><input type="checkbox" name="${box}" value="${it.id}" ${on ? 'checked' : ''}>
  <span>${esc(it.name)}${it.owner ? `<small>${esc(it.owner)}</small>` : ''}</span></label>`;
function itemPickerHTML(box, selected) {
  return `
    <div class="picks" id="${box}">${state.data.items.map((it) => itemChip(box, it, selected.includes(it.id))).join('')}</div>
    ${state.data.items.length ? '' : '<p class="hint">아래에서 새 준비물을 추가하면 준비물 목록에도 함께 등록됩니다.</p>'}
    <div class="new-row">
      <input data-new-item-name="${box}" placeholder="새 준비물 (목록에 없을 때)" aria-label="새 준비물 이름">
      <input data-new-item-owner="${box}" placeholder="담당" aria-label="담당" class="owner">
      <button type="button" class="mini" data-new-item="${box}">추가</button>
    </div>`;
}
/* 모달 공통 부품: 이미지 목록 (#imgList, #imgInput, #upStatus, #mSave 필요) */
function mountImageEditor(images, folder) {
  const list = $('#imgList');
  const draw = () => {
    list.innerHTML = images.length
      ? images.map((im, j) => `
        <div class="img-item">
          <span class="img-n">${j + 1}</span>
          <img src="${esc(imgSrc(im.src))}" alt="이미지 ${j + 1}">
          <input class="img-cap" data-j="${j}" value="${esc(im.cap || '')}" placeholder="설명 (선택)" aria-label="이미지 ${j + 1} 설명">
          <div class="img-tools">
            <button type="button" class="mini" data-mv="${j}|-1" ${j === 0 ? 'disabled' : ''} aria-label="앞으로">↑</button>
            <button type="button" class="mini" data-mv="${j}|1" ${j === images.length - 1 ? 'disabled' : ''} aria-label="뒤로">↓</button>
            <button type="button" class="mini danger" data-rm="${j}" aria-label="삭제">✕</button>
          </div>
        </div>`).join('')
      : '<div class="empty sm">아직 이미지가 없습니다.</div>';
  };
  draw();
  list.oninput = (e) => { if (e.target.matches('.img-cap')) images[+e.target.dataset.j].cap = e.target.value; };
  list.onclick = (e) => {
    const mv = e.target.closest('[data-mv]');
    const rm = e.target.closest('[data-rm]');
    if (mv) {
      const [j, d] = mv.dataset.mv.split('|').map(Number);
      const [item] = images.splice(j, 1);
      images.splice(j + d, 0, item);
      draw();
    } else if (rm) {
      images.splice(+rm.dataset.rm, 1);
      draw();
    }
  };
  $('#imgInput').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const status = $('#upStatus');
    const saveBtn = $('#mSave');
    saveBtn.disabled = true;
    for (const [n, file] of files.entries()) {
      status.textContent = `이미지 ${state.localOnly ? '처리' : '업로드'} 중… (${n + 1}/${files.length})`;
      try {
        const dataUrl = await compress(file);
        let src = dataUrl;
        if (!state.localOnly) {
          src = await uploadImage(dataUrl, folder);
          state.imgCache[src] = dataUrl;
        }
        images.push({ src, cap: '' });
        draw();
      } catch (err) {
        toast(`${file.name}: ${err.status === 403 ? '토큰에 쓰기 권한이 없습니다.' : err.message}`, 4000);
      }
    }
    status.textContent = state.localOnly
      ? '임시 편집: 이미지가 data.json 안에 함께 저장됩니다.'
      : '이미지를 저장소에 올렸습니다. ‘확인’ 후 상단의 ‘저장’을 눌러 주세요.';
    saveBtn.disabled = false;
  };
}
const imageFieldHTML = (legend) => `
  <fieldset>
    <legend>${legend}</legend>
    <div class="img-list" id="imgList"></div>
    <label class="upload"><input type="file" accept="image/*" multiple id="imgInput"><span>＋ 이미지 추가 (여러 장 선택 가능)</span></label>
    <div class="hint" id="upStatus"></div>
  </fieldset>`;

function openLogin() {
  openModal(`
    <form id="loginForm">
      <div class="m-head"><h2>관리자 로그인</h2><button type="button" class="icon-btn" data-act="close-modal" aria-label="닫기">✕</button></div>
      <div class="m-body">
        <p class="hint">수정한 일정은 GitHub 저장소의 data.json에 바로 저장됩니다. 저장소에 쓰기 권한이 있는 GitHub 토큰으로 로그인해 주세요.</p>
        <label>저장소 (아이디/저장소이름)<input name="repo" required value="${esc(guessRepo())}" placeholder="예: myid/sungdo-night-2026"></label>
        <label>GitHub 토큰<input name="token" type="password" required autocomplete="off" placeholder="ghp_… 또는 github_pat_…"></label>
        <p class="hint">토큰은 이 브라우저 탭을 닫으면 지워집니다. 토큰 만드는 방법은 README.md를 참고하세요.</p>
        <div class="err" id="loginErr"></div>
      </div>
      <div class="m-foot">
        <button type="button" class="btn ghost left" data-act="local-edit">토큰 없이 미리 편집</button>
        <button class="btn primary" id="loginBtn">로그인</button>
      </div>
    </form>`);
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $('#loginBtn');
    btn.disabled = true; btn.textContent = '확인 중…';
    try {
      await login(f.get('token'), f.get('repo'));
      closeModal();
      toast('관리자 모드입니다. 수정 후 ‘저장’을 눌러 주세요.');
      render();
    } catch (err) {
      $('#loginErr').textContent = err.message;
      btn.disabled = false; btn.textContent = '로그인';
    }
  };
}

function openEventModal(evId, date) {
  const orig = evId ? findEv(evId) : null;
  const ev = orig || { id: uid(), date, type: '촬영', title: '', start: '09:00', end: '12:00', locationId: '', people: [], extra: '', memo: '', items: [], done: {}, scenes: [] };
  const picks = (list) => list.map((p) => `
    <label class="pick"><input type="checkbox" name="people" value="${p.id}" ${ev.people.includes(p.id) ? 'checked' : ''}>
    <span>${esc(p.name || '(미정)')}<small>${esc(p.role)}</small></span></label>`).join('');
  const { cast, staff } = state.data;
  openModal(`
    <form id="evForm">
      <div class="m-head"><h2>${orig ? '일정 수정' : '일정 추가'}</h2><button type="button" class="icon-btn" data-act="close-modal" aria-label="닫기">✕</button></div>
      <div class="m-body">
        <div class="row2">
          <label>날짜<input type="date" name="date" required min="${RANGE_START}" max="${RANGE_END}" value="${ev.date}"></label>
          <label>종류<select name="type">${TYPES.map((t) => `<option ${t.key === ev.type ? 'selected' : ''}>${t.key}</option>`).join('')}</select></label>
        </div>
        <label>제목<input name="title" maxlength="60" value="${esc(ev.title)}" placeholder="예: 1차 본촬영"></label>
        <div class="row2">
          <label>시작 시간<input type="time" name="start" required value="${esc(ev.start)}"></label>
          <label>종료 시간<input type="time" name="end" value="${esc(ev.end)}"></label>
        </div>
        <div class="field"><span class="flabel">장소</span>${locSelectHTML('evLoc', ev.locationId, '(장소 미정)')}</div>
        <fieldset>
          <legend>참여 인원</legend>
          ${cast.length || staff.length
            ? `${cast.length ? `<div><div class="pick-label">배역</div><div class="picks">${picks(cast)}</div></div>` : ''}
               ${staff.length ? `<div><div class="pick-label">스태프</div><div class="picks">${picks(staff)}</div></div>` : ''}`
            : '<p class="hint">왼쪽 ‘촬영 인원’ 메뉴에서 배역과 스태프를 먼저 등록하면 여기서 고를 수 있습니다.</p>'}
          <label>그 외 인원<input name="extra" value="${esc(ev.extra)}" placeholder="예: 보조 출연 3명"></label>
        </fieldset>
        <fieldset>
          <legend>공통 준비물 <small>(씬별 소품은 씬에서 고릅니다)</small></legend>
          ${itemPickerHTML('evItems', ev.items)}
        </fieldset>
        <label>메모<textarea name="memo" rows="3" placeholder="집합 시간, 주의 사항 등">${esc(ev.memo)}</textarea></label>
      </div>
      <div class="m-foot">
        <button type="button" class="btn" data-act="close-modal">취소</button>
        <button class="btn primary" id="mSave">확인</button>
      </div>
    </form>`);
  $('#evForm').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const start = f.get('start');
    const end = f.get('end');
    if (end && end < start) { toast('종료 시간이 시작 시간보다 빠릅니다.'); return; }
    Object.assign(ev, {
      date: f.get('date'), type: f.get('type'), title: f.get('title').trim(), start, end,
      locationId: f.get('evLoc'), people: f.getAll('people'), extra: f.get('extra').trim(), memo: f.get('memo').trim(),
      items: f.getAll('evItems'),
    });
    if (!orig) state.data.events.push(ev);
    markDirty();
    closeModal();
    ensureMonth(ev.date);
    state.openDate = ev.date;
    render();
  };
}

function openSceneModal(evId, sceneId) {
  const ev = findEv(evId);
  if (!ev) return;
  const orig = sceneId ? ev.scenes.find((s) => s.id === sceneId) : null;
  const s = orig
    ? JSON.parse(JSON.stringify(orig))
    : { id: uid(), time: ev.start || '', no: `S#${ev.scenes.length + 1}`, title: '', desc: '', locationId: '', cast: [], items: [], images: [] };
  const evLocName = findLoc(ev.locationId)?.name;
  const castPicks = state.data.cast.map((p) => `
    <label class="pick"><input type="checkbox" name="cast" value="${p.id}" ${s.cast.includes(p.id) ? 'checked' : ''}>
    <span>${esc(p.role)}<small>${esc(p.name)}</small></span></label>`).join('');
  openModal(`
    <form id="scForm">
      <div class="m-head"><h2>${orig ? '씬 수정' : '씬 추가'}</h2><button type="button" class="icon-btn" data-act="close-modal" aria-label="닫기">✕</button></div>
      <div class="m-body">
        <div class="row2">
          <label>촬영 시간<input type="time" name="time" required value="${esc(s.time)}"></label>
          <label>씬 번호<input name="no" maxlength="12" value="${esc(s.no)}" placeholder="예: S#3"></label>
        </div>
        <label>씬 제목<input name="title" maxlength="60" required value="${esc(s.title)}" placeholder="예: 식당에서의 첫 만남"></label>
        <div class="field"><span class="flabel">촬영 장소</span>${locSelectHTML('scLoc', s.locationId, `일정 장소와 같음${evLocName ? ` (${evLocName})` : ''}`)}</div>
        <label>간단 설명<textarea name="desc" rows="2" placeholder="한두 줄로 적어 주세요">${esc(s.desc)}</textarea></label>
        ${castPicks ? `<fieldset><legend>등장 배역</legend><div class="picks">${castPicks}</div></fieldset>` : ''}
        <fieldset>
          <legend>이 씬의 준비물·소품</legend>
          ${itemPickerHTML('scItems', s.items)}
        </fieldset>
        ${imageFieldHTML('콘티 이미지 <small>(위에서부터 순서대로 보여집니다)</small>')}
      </div>
      <div class="m-foot">
        ${orig ? '<button type="button" class="btn danger left" id="delScene">씬 삭제</button>' : ''}
        <button type="button" class="btn" data-act="close-modal">취소</button>
        <button class="btn primary" id="mSave">확인</button>
      </div>
    </form>`);
  mountImageEditor(s.images, 'scenes');
  $('#delScene')?.addEventListener('click', () => {
    if (!confirm(`${orig.no} ${orig.title} 씬을 삭제할까요?`)) return;
    ev.scenes = ev.scenes.filter((x) => x.id !== orig.id);
    markDirty(); closeModal(); render();
  });
  $('#scForm').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    let locationId = f.get('scLoc');
    if (locationId === ev.locationId) locationId = ''; // 일정 장소와 같으면 '같음'으로 저장
    Object.assign(s, {
      time: f.get('time'), no: f.get('no').trim(), title: f.get('title').trim(), desc: f.get('desc').trim(),
      locationId, cast: f.getAll('cast'), items: f.getAll('scItems'),
    });
    if (orig) Object.assign(orig, s); else ev.scenes.push(s);
    markDirty(); closeModal(); render();
  };
}

function openLocModal(locId) {
  const orig = locId ? findLoc(locId) : null;
  const l = orig ? JSON.parse(JSON.stringify(orig)) : { id: uid(), name: '', address: '', lat: '', lng: '', memo: '', photos: [] };
  openModal(`
    <form id="locForm">
      <div class="m-head"><h2>${orig ? '장소 수정' : '장소 추가'}</h2><button type="button" class="icon-btn" data-act="close-modal" aria-label="닫기">✕</button></div>
      <div class="m-body">
        <label>장소 이름<input name="name" required maxlength="40" value="${esc(l.name)}" placeholder="예: 연대 기숙사 앞"></label>
        <label>주소<input name="address" value="${esc(l.address)}" placeholder="예: 서울 서대문구 연세로 50"></label>
        <div class="row2">
          <label>위도 (선택)<input name="lat" id="locLat" inputmode="decimal" value="${esc(l.lat)}" placeholder="37.5665"></label>
          <label>경도 (선택)<input name="lng" id="locLng" inputmode="decimal" value="${esc(l.lng)}" placeholder="126.9780"></label>
        </div>
        <button type="button" class="btn sm" data-act="geo">📍 지금 내 위치 넣기</button>
        <p class="hint">주소만 넣어도 지도가 나옵니다. 정확한 지점이 필요하면 현장에서 ‘지금 내 위치 넣기’를 누르거나, 지도 앱에서 좌표를 복사해 넣으세요.</p>
        <label>메모<textarea name="memo" rows="2" placeholder="주차, 출입 방법, 섭외 담당 등">${esc(l.memo)}</textarea></label>
        ${imageFieldHTML('장소 사진')}
      </div>
      <div class="m-foot">
        ${orig ? '<button type="button" class="btn danger left" id="delLoc">장소 삭제</button>' : ''}
        <button type="button" class="btn" data-act="close-modal">취소</button>
        <button class="btn primary" id="mSave">확인</button>
      </div>
    </form>`);
  mountImageEditor(l.photos, 'locations');
  $('#delLoc')?.addEventListener('click', () => {
    const used = locUsage(orig.id).length;
    if (!confirm(`‘${orig.name}’ 장소를 삭제할까요?${used ? ` 이 장소를 쓰는 일정·씬 ${used}곳에서는 장소가 비워집니다.` : ''}`)) return;
    state.data.locations = state.data.locations.filter((x) => x.id !== orig.id);
    state.data.events.forEach((e) => {
      if (e.locationId === orig.id) e.locationId = '';
      e.scenes.forEach((s) => { if (s.locationId === orig.id) s.locationId = ''; });
    });
    if (state.viewer?.kind === 'loc' && state.viewer.id === orig.id) state.viewer = null;
    markDirty(); closeModal(); render();
  });
  $('#locForm').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const lat = f.get('lat').trim();
    const lng = f.get('lng').trim();
    if ((lat || lng) && (isNaN(+lat) || isNaN(+lng) || !lat || !lng)) { toast('위도와 경도는 숫자로 둘 다 넣어 주세요.'); return; }
    const name = f.get('name').trim();
    if (state.data.locations.some((x) => x.id !== l.id && norm(x.name) === norm(name))) { toast('같은 이름의 장소가 이미 있습니다.'); return; }
    Object.assign(l, { name, address: f.get('address').trim(), lat, lng, memo: f.get('memo').trim() });
    if (orig) Object.assign(orig, l); else state.data.locations.push(l);
    markDirty(); closeModal(); render();
  };
}

function openLinkModal(kind) {
  const label = VIEW_TITLES[kind];
  openModal(`
    <form id="linkForm">
      <div class="m-head"><h2>${label} 문서 연결</h2><button type="button" class="icon-btn" data-act="close-modal" aria-label="닫기">✕</button></div>
      <div class="m-body">
        <label>문서 주소<input name="url" type="url" value="${esc(state.data.links[kind] || '')}" placeholder="https://docs.google.com/document/d/…"></label>
        <p class="hint">구글 문서, 프레젠테이션, 드라이브 PDF 주소를 붙여 넣으세요. 문서의 공유 설정은 ‘링크가 있는 모든 사용자: 뷰어’여야 합니다. 원본 문서를 고치면 이 화면에도 그대로 반영됩니다.</p>
      </div>
      <div class="m-foot">
        <button type="button" class="btn" data-act="close-modal">취소</button>
        <button class="btn primary">확인</button>
      </div>
    </form>`);
  $('#linkForm').onsubmit = (e) => {
    e.preventDefault();
    const url = new FormData(e.target).get('url').trim();
    if (url && !embedUrl(url)) { toast('https:// 로 시작하는 주소를 넣어 주세요.'); return; }
    state.data.links[kind] = url;
    markDirty(); closeModal(); render();
  };
}

/* 모달 안에서 새 장소 / 새 준비물 바로 등록 */
function addLocFromModal(name) {
  const input = $(`[data-new-loc-name="${name}"]`);
  const val = input.value.trim();
  if (!val) { input.focus(); return; }
  let l = state.data.locations.find((x) => norm(x.name) === norm(val));
  if (!l) {
    l = { id: uid(), name: val, address: '', lat: '', lng: '', memo: '', photos: [] };
    state.data.locations.push(l);
    $(`#sel-${name}`).insertAdjacentHTML('beforeend', `<option value="${l.id}">${esc(l.name)}</option>`);
    markDirty();
    toast(`‘${val}’ 장소를 등록했습니다. 주소와 사진은 ‘촬영 장소’ 메뉴에서 넣을 수 있습니다.`, 4000);
  }
  $(`#sel-${name}`).value = l.id;
  input.value = '';
}
function addItemFromModal(box) {
  const nameEl = $(`[data-new-item-name="${box}"]`);
  const ownerEl = $(`[data-new-item-owner="${box}"]`);
  const name = nameEl.value.trim();
  const owner = ownerEl.value.trim();
  if (!name) { nameEl.focus(); return; }
  let it = state.data.items.find((x) => norm(x.name) === norm(name) && norm(x.owner) === norm(owner));
  if (!it) {
    it = { id: uid(), name, owner };
    state.data.items.push(it);
    markDirty();
  }
  // 이 모달의 다른 준비물 선택 칸에도 칩을 추가
  $$('.picks[id$="Items"]').forEach((boxEl) => {
    if (!$(`input[value="${it.id}"]`, boxEl)) boxEl.insertAdjacentHTML('beforeend', itemChip(boxEl.id, it, false));
  });
  $(`#${box} input[value="${it.id}"]`).checked = true;
  nameEl.value = ''; ownerEl.value = '';
  nameEl.focus();
}

/* ---------- 이벤트 처리 ---------- */
function openDay(k) { state.openDate = k; renderDrawer(); }
function switchScene(id) {
  state.viewer.sceneId = id;
  renderViewer();
  $('#vScroll')?.scrollTo(0, 0);
}
function openViewer(v) {
  state.viewer = v;
  renderViewer();
  $('#vScroll')?.scrollTo(0, 0);
}
function goto(k) {
  state.view = 'calendar';
  state.viewer = null;
  ensureMonth(k);
  state.openDate = k;
  render();
}

async function logout() {
  if (state.dirty && !confirm('저장하지 않은 수정 내용이 있습니다. 그래도 나갈까요?')) return;
  state.admin = false; state.localOnly = false; state.gh = null; state.sha = null; state.dirty = false;
  store.del('gh');
  await loadData();
  render();
}

function keepScrollRender() {
  const pg = $('#main .page, #main .people');
  const sc = pg?.scrollTop || 0;
  render();
  const pg2 = $('#main .page, #main .people');
  if (pg2) pg2.scrollTop = sc;
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act],[data-add],[data-edit-ev],[data-del-ev],[data-add-scene],[data-edit-scene],[data-scene],[data-vjump],[data-vscene],[data-goto],[data-view],[data-add-p],[data-del-p],[data-toggle],[data-loc],[data-edit-loc],[data-lb],[data-lbi],[data-suptab],[data-del-it],[data-new-item],[data-new-loc],[data-srow],[data-day]');
  if (!t) return;
  const d = t.dataset;

  if (d.srow) {
    hideHoverCard();
    if (canHover()) {
      const [a, b] = d.srow.split('|');
      openViewer({ kind: 'scene', evId: a, sceneId: b });
    } else {
      t.classList.toggle('open'); // 휴대폰: 눌러서 펼치기
    }
    return;
  }

  if (d.act) {
    switch (d.act) {
      case 'prev': if (state.mi > 0) { state.mi--; render(); } break;
      case 'next': if (state.mi < MONTHS.length - 1) { state.mi++; render(); } break;
      case 'today': {
        if (inRange(todayKey)) { ensureMonth(todayKey); render(); openDay(todayKey); } else { state.mi = 0; render(); }
        break;
      }
      case 'login': openLogin(); break;
      case 'logout': logout(); break;
      case 'save': save(); break;
      case 'close-day': state.openDate = null; renderDrawer(); break;
      case 'close-viewer': state.viewer = null; renderViewer(); break;
      case 'viewer-back': openViewer(state.viewer.back); break;
      case 'close-lb': state.lightbox = null; renderLightbox(); break;
      case 'close-modal': closeModal(); break;
      case 'download-json': downloadJson(); break;
      case 'set-link': openLinkModal(state.view); break;
      case 'add-loc': openLocModal(); break;
      case 'add-cat':
        state.data.items.push({ id: uid(), name: '', owner: '' });
        markDirty(); keepScrollRender();
        $$('[data-it$="|name"]').pop()?.focus();
        break;
      case 'geo':
        if (!navigator.geolocation) { toast('이 브라우저에서는 위치를 가져올 수 없습니다.'); break; }
        toast('위치를 확인하는 중입니다…');
        navigator.geolocation.getCurrentPosition(
          (p) => { $('#locLat').value = p.coords.latitude.toFixed(6); $('#locLng').value = p.coords.longitude.toFixed(6); toast('현재 위치를 넣었습니다.'); },
          () => toast('위치를 가져오지 못했습니다. 브라우저의 위치 권한을 확인해 주세요.', 4000),
          { enableHighAccuracy: true, timeout: 10000 },
        );
        break;
      case 'local-edit':
        state.admin = true; state.localOnly = true; state.gh = null;
        closeModal(); render();
        toast('임시 편집 모드입니다. 수정 후 ‘data.json 받기’로 파일을 내려받아 저장소에 올려 주세요.', 5000);
        break;
    }
    return;
  }
  if (d.newItem) { addItemFromModal(d.newItem); return; }
  if (d.newLoc) { addLocFromModal(d.newLoc); return; }
  if (d.toggle) {
    const [eid, iid] = d.toggle.split('|');
    const ev = findEv(eid);
    if (ev && state.admin) {
      ev.done[iid] = !ev.done[iid];
      if (!ev.done[iid]) delete ev.done[iid];
      markDirty();
      keepScrollRender();
    }
    return;
  }
  if (d.vjump !== undefined) { $(`#vcut-${d.vjump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (d.lb !== undefined) {
    const l = findLoc(state.viewer?.id);
    if (l) { state.lightbox = { images: l.photos, idx: +d.lb }; renderLightbox(); }
    return;
  }
  if (d.lbi !== undefined) { if (state.lightbox) { state.lightbox.idx = +d.lbi; renderLightbox(); } return; }
  if (d.suptab) { state.supTab = d.suptab; render(); return; }
  if (d.editLoc) { openLocModal(d.editLoc); return; }
  if (d.loc) {
    const back = state.viewer?.kind === 'scene' ? { ...state.viewer } : null;
    openViewer({ kind: 'loc', id: d.loc, back });
    return;
  }
  if (d.view) { state.view = d.view; render(); $('#main .page, #main .people')?.scrollTo(0, 0); return; }
  if (d.goto) { goto(d.goto); return; }
  if (d.add) { openEventModal(null, d.add); return; }
  if (d.editEv) { openEventModal(d.editEv); return; }
  if (d.delEv) {
    const ev = findEv(d.delEv);
    if (ev && confirm(`‘${ev.title || ev.type}’ 일정을 삭제할까요? (씬 ${ev.scenes.length}개도 함께 삭제됩니다)`)) {
      state.data.events = state.data.events.filter((x) => x.id !== ev.id);
      markDirty(); render();
    }
    return;
  }
  if (d.addScene) { openSceneModal(d.addScene); return; }
  if (d.editScene) { const [a, b] = d.editScene.split('|'); openSceneModal(a, b); return; }
  if (d.scene) { const [a, b] = d.scene.split('|'); openViewer({ kind: 'scene', evId: a, sceneId: b }); return; }
  if (d.vscene) { if (state.viewer) switchScene(d.vscene); return; }
  if (d.addP) {
    state.data[d.addP].push({ id: uid(), role: '', name: '' });
    markDirty(); keepScrollRender();
    const inputs = $$(`[data-p^="${d.addP}|"]`);
    inputs[inputs.length - 2]?.focus();
    return;
  }
  if (d.delP) {
    const [kind, id] = d.delP.split('|');
    const p = state.data[kind].find((x) => x.id === id);
    if (!confirm(`‘${p.role || '이름 없음'} ${p.name || ''}’을(를) 삭제할까요? 일정에서도 함께 빠집니다.`)) return;
    state.data[kind] = state.data[kind].filter((x) => x.id !== id);
    state.data.events.forEach((ev) => {
      ev.people = ev.people.filter((x) => x !== id);
      ev.scenes.forEach((s) => { s.cast = s.cast.filter((x) => x !== id); });
    });
    markDirty(); keepScrollRender();
    return;
  }
  if (d.delIt) {
    const it = findCat(d.delIt);
    const used = itemUsage(it.id).length;
    if (!confirm(`‘${it.name || '이름 없음'}’을(를) 삭제할까요?${used ? ` 일정 ${used}곳의 준비물에서도 빠집니다.` : ''}`)) return;
    state.data.items = state.data.items.filter((x) => x.id !== it.id);
    state.data.events.forEach((ev) => {
      ev.items = ev.items.filter((x) => x !== it.id);
      delete ev.done[it.id];
      ev.scenes.forEach((s) => { s.items = s.items.filter((x) => x !== it.id); });
    });
    markDirty(); keepScrollRender();
    return;
  }
  if (d.day) { openDay(d.day); }
});

document.addEventListener('input', (e) => {
  const ds = e.target.dataset || {};
  if (ds.p) {
    const [kind, id, field] = ds.p.split('|');
    const person = state.data[kind].find((x) => x.id === id);
    if (person) { person[field] = e.target.value; markDirty(); }
  } else if (ds.it) {
    const [id, field] = ds.it.split('|');
    const it = findCat(id);
    if (it) { it[field] = e.target.value; markDirty(); }
  }
});
document.addEventListener('change', (e) => { if (e.target.dataset?.p) renderSide(); });

document.addEventListener('keydown', (e) => {
  // 모달 안 '새 장소/새 준비물' 칸에서 Enter → 폼 제출 대신 추가
  if (e.key === 'Enter' && e.target.matches?.('[data-new-item-name],[data-new-item-owner],[data-new-loc-name]')) {
    e.preventDefault();
    const ds = e.target.dataset;
    if (ds.newLocName) addLocFromModal(ds.newLocName);
    else addItemFromModal(ds.newItemName || ds.newItemOwner);
    return;
  }
  if (e.key === 'Escape') {
    if (modalOpen()) closeModal();
    else if (state.lightbox) { state.lightbox = null; renderLightbox(); }
    else if (state.viewer) { state.viewer = null; renderViewer(); }
    else if (state.openDate) { state.openDate = null; renderDrawer(); }
    return;
  }
  if (modalOpen()) return;
  if (state.lightbox && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    state.lightbox.idx += e.key === 'ArrowLeft' ? -1 : 1;
    renderLightbox();
    return;
  }
  if (state.viewer?.kind === 'scene' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const id = $(`#viewer [data-vscene]:${e.key === 'ArrowLeft' ? 'first' : 'last'}-of-type`)?.dataset.vscene;
    if (id) switchScene(id);
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-day]')) {
    e.preventDefault();
    openDay(e.target.dataset.day);
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-srow]')) {
    e.preventDefault();
    e.target.click();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- 시작 ---------- */
(async function init() {
  await loadData();
  const now = new Date();
  const i = MONTHS.findIndex((x) => x.y === now.getFullYear() && x.m === now.getMonth());
  if (i >= 0) state.mi = i;
  try {
    const saved = JSON.parse(store.get('gh') || 'null');
    if (saved?.token) await login(saved.token, `${saved.owner}/${saved.repo}`);
  } catch {
    store.del('gh');
  }
  render();
})();
