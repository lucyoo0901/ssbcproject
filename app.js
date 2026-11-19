'use strict';
/* =========================================================
   2026 성도교제밤 촬영일자
   - 일정 데이터: 저장소의 data.json (모두가 읽음)
   - 관리자 저장: GitHub API로 data.json / images/scenes/* 에 직접 커밋
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
const VIEW_TITLES = { people: '촬영 인원', supplies: '준비물', script: '대본', storyboard: '스토리보드' };

/* ---------- 상태 ---------- */
const state = {
  data: null,
  mi: 0,              // 보고 있는 달 (MONTHS 인덱스)
  view: 'calendar',   // calendar | people | supplies | script | storyboard
  openDate: null,     // 서랍에 열린 날짜
  viewer: null,       // { evId, sceneId }
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

/* ---------- 데이터 ---------- */
function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  d.cast = Array.isArray(d.cast) ? d.cast : [];
  d.staff = Array.isArray(d.staff) ? d.staff : [];
  d.events = Array.isArray(d.events) ? d.events : [];
  d.links = d.links && typeof d.links === 'object' ? d.links : {};
  d.events.forEach((e) => {
    e.id ||= uid();
    e.people ||= [];
    e.supplies ||= [];
    e.scenes ||= [];
    e.scenes.forEach((s) => {
      s.id ||= uid();
      s.cast ||= [];
      s.props ||= [];
      s.location ||= '';
      s.images = (s.images || []).map((im) => (typeof im === 'string' ? { src: im, cap: '' } : im));
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
const eventsOn = (k) => state.data.events.filter((e) => e.date === k).sort((a, b) => byTime(a.start, b.start));
const sortScenes = (ev) => [...ev.scenes].sort((a, b) => byTime(a.time, b.time));
function findPerson(id) {
  const c = state.data.cast.find((p) => p.id === id);
  if (c) return { ...c, kind: 'cast' };
  const s = state.data.staff.find((p) => p.id === id);
  return s ? { ...s, kind: 'staff' } : null;
}
const pchip = (p) => `<span class="pchip ${p.kind}">${esc(p.name || '(미정)')}<small>${esc(p.role)}</small></span>`;
/* 준비물: 일정 공통 + 씬별 */
function suppliesOf(e) {
  return [
    ...e.supplies.map((it) => ({ it, tag: '공통', key: `${e.id}||${it.id}` })),
    ...sortScenes(e).flatMap((s) => s.props.map((it) => ({ it, tag: s.no || '씬', key: `${e.id}|${s.id}|${it.id}` }))),
  ];
}
function findItem(key) {
  const [eid, sid, iid] = key.split('|');
  const e = findEv(eid);
  if (!e) return null;
  const list = sid ? e.scenes.find((s) => s.id === sid)?.props : e.supplies;
  return list?.find((x) => x.id === iid) || null;
}
function suppliesListHTML(list, showTag = true) {
  return `<ul class="supplies">${list.map(({ it, tag, key }) => `
    <li class="${it.done ? 'done' : ''}">
      ${state.admin
        ? `<button class="chk" data-toggle="${key}" aria-pressed="${!!it.done}" aria-label="${esc(it.name)} 준비 완료 표시">${it.done ? '✓' : ''}</button>`
        : `<span class="chk" aria-hidden="true">${it.done ? '✓' : ''}</span>`}
      <span class="it-n">${esc(it.name)}</span>
      ${it.owner ? `<span class="it-o">${esc(it.owner)}</span>` : ''}
      ${showTag ? `<span class="it-tag">${esc(tag)}</span>` : ''}
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

/* 모달 안의 준비물 입력 목록 */
const itemRowHTML = (it) => `
  <div class="item-row" data-id="${it.id}">
    <input class="it-name" value="${esc(it.name)}" placeholder="품목 (예: 삼각대 2개)" aria-label="품목">
    <input class="it-owner" value="${esc(it.owner || '')}" placeholder="담당 (선택)" aria-label="담당">
    <button type="button" class="mini danger" data-rm-item aria-label="삭제">✕</button>
  </div>`;
const itemsEditorHTML = (id, items) => `
  <div class="items-ed" id="${id}">${items.map(itemRowHTML).join('')}</div>
  <button type="button" class="mini" data-add-item="${id}">+ 준비물 추가</button>`;
function readItems(id, old) {
  return $$(`#${id} .item-row`).map((r) => {
    const prev = old.find((o) => o.id === r.dataset.id);
    return { id: r.dataset.id, name: $('.it-name', r).value.trim(), owner: $('.it-owner', r).value.trim(), done: prev?.done || false };
  }).filter((x) => x.name);
}

function datesOf(id) {
  const set = new Set();
  state.data.events.forEach((e) => {
    if (e.people.includes(id) || e.scenes.some((s) => s.cast.includes(id))) set.add(e.date);
  });
  return [...set].sort();
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
    toast('저장했습니다. 사이트에 반영되기까지 1~2분 걸릴 수 있습니다.', 4000);
  } catch (e) {
    if (e.status === 409 || e.status === 422) toast('다른 곳에서 먼저 수정되었습니다. 나가기 후 다시 로그인해 주세요.', 5000);
    else toast(`저장하지 못했습니다: ${e.message}`, 5000);
  }
  render();
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(state.data, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'data.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('data.json을 내려받았습니다. 저장소의 같은 파일을 이것으로 바꿔 올려 주세요.', 4500);
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

async function uploadImage(dataUrl) {
  const path = `images/scenes/${Date.now()}-${uid()}.jpg`;
  await gh(`/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message: '콘티 이미지 추가', content: dataUrl.split(',')[1], branch: state.gh.branch }),
  });
  return path;
}

/* ---------- 렌더링 ---------- */
function render() {
  document.body.classList.toggle('is-admin', state.admin);
  renderSide();
  const body = {
    calendar: calendarHTML, people: peopleHTML, supplies: suppliesPageHTML,
    script: () => docHTML('script'), storyboard: () => docHTML('storyboard'),
  }[state.view] || calendarHTML;
  $('#main').innerHTML = topbarHTML() + body();
  renderDrawer();
  renderViewer();
}

function renderSide() {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  const list = state.data.events
    .filter((e) => e.type === '촬영')
    .sort((a, b) => byTime(a.date + a.start, b.date + b.start));
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
  const docTools = isDoc
    ? `${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">새 창에서 열기 ↗</a>` : ''}
       ${state.admin ? `<button class="btn" data-act="set-link">링크 설정</button>` : ''}`
    : '';
  const right = docTools + (state.admin
    ? `<span class="mode admin">${state.localOnly ? '임시 편집' : '관리자'}</span>
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
      ${e.location ? `<div class="ev-meta">📍 ${esc(e.location)}</div>` : ''}
      ${people.length || e.extra ? `<div class="pchips">${people.map(pchip).join('')}${e.extra ? `<span class="pchip">${esc(e.extra)}</span>` : ''}</div>` : ''}
      ${e.memo ? `<p class="ev-memo">${esc(e.memo)}</p>` : ''}
      ${showScenes ? `
        <div class="scenes">
          <div class="scenes-h"><span>씬 스케줄</span>${state.admin ? `<button class="mini" data-add-scene="${e.id}">+ 씬 추가</button>` : ''}</div>
          ${scenes.map((s) => `
            <div class="scene-row">
              <button class="scene-main" data-scene="${e.id}|${s.id}" aria-label="${esc(s.no)} ${esc(s.title)} 콘티 보기">
                <span class="s-time">${esc(s.time || '')}</span>
                <span class="s-no">${esc(s.no || '')}</span>
                <span class="s-title">${esc(s.title || '제목 없음')}${s.location || s.desc ? `<small>${s.location ? `📍 ${esc(s.location)}${s.desc ? ' · ' : ''}` : ''}${esc(s.desc)}</small>` : ''}</span>
                <span class="s-img">${s.images.length ? `🖼 ${s.images.length}` : ''}</span>
              </button>
              ${state.admin ? `<button class="mini" data-edit-scene="${e.id}|${s.id}" aria-label="씬 수정">✎</button>` : ''}
            </div>`).join('')}
          ${scenes.length ? '' : '<div class="empty sm">씬을 추가해 주세요.</div>'}
        </div>` : ''}
      ${supplies.length ? `
        <div class="scenes">
          <div class="scenes-h"><span>준비물</span><span>${supplies.filter((x) => x.it.done).length} / ${supplies.length} 준비됨</span></div>
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

function renderViewer() {
  const v = $('#viewer');
  const st = state.viewer;
  if (!st) { v.classList.remove('open'); v.innerHTML = ''; return; }
  const ev = findEv(st.evId);
  const scenes = ev ? sortScenes(ev) : [];
  const si = scenes.findIndex((s) => s.id === st.sceneId);
  if (si < 0) { state.viewer = null; renderViewer(); return; }
  const s = scenes[si];
  const imgs = s.images;
  const cast = s.cast.map(findPerson).filter(Boolean);
  const loc = s.location || ev.location;
  const props = s.props.map((it) => ({ it, tag: '', key: `${ev.id}|${s.id}|${it.id}` }));
  const prev = scenes[si - 1];
  const next = scenes[si + 1];
  const keepScroll = $('#vScroll')?.scrollTop || 0;
  v.innerHTML = `
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
          ${loc ? `<div class="v-row"><span class="v-k">장소</span><span>${esc(loc)}${s.location && ev.location && s.location !== ev.location ? ' <small>(장소 변경)</small>' : ''}</span></div>` : ''}
          ${s.desc ? `<div class="v-row"><span class="v-k">내용</span><span class="v-desc">${esc(s.desc)}</span></div>` : ''}
          ${cast.length ? `<div class="v-row"><span class="v-k">배역</span><div class="pchips">${cast.map(pchip).join('')}</div></div>` : ''}
          ${props.length ? `<div class="v-row"><span class="v-k">준비물</span>${suppliesListHTML(props, false)}</div>` : ''}
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
  v.classList.add('open');
  $('#vScroll').scrollTop = keepScroll;
}

function suppliesPageHTML() {
  const evs = [...state.data.events]
    .sort((a, b) => byTime(a.date + a.start, b.date + b.start))
    .map((e) => ({ e, list: suppliesOf(e) }))
    .filter((x) => x.list.length);
  if (!evs.length) {
    return `<div class="people"><div class="card"><div class="empty">${state.admin
      ? '일정이나 씬을 수정할 때 ‘준비물’을 추가하면 여기에 날짜별로 모입니다.'
      : '아직 등록된 준비물이 없습니다.'}</div></div></div>`;
  }
  return `<div class="people">${evs.map(({ e, list }) => {
    const done = list.filter((x) => x.it.done).length;
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

/* ---------- 모달 ---------- */
function openModal(html) {
  $('#modal-root').innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  setTimeout(() => $('#modal-root input:not([type=hidden]), #modal-root select')?.focus(), 30);
}
function closeModal() { $('#modal-root').innerHTML = ''; }
const modalOpen = () => !!$('#modal-root').children.length;

function openLogin() {
  openModal(`
    <form id="loginForm">
      <div class="m-head"><h2>관리자 로그인</h2><button type="button" class="icon-btn" data-act="close-modal" aria-label="닫기">✕</button></div>
      <div class="m-body">
        <p class="hint">수정한 일정은 GitHub 저장소의 data.json에 바로 저장됩니다. 저장소에 쓰기 권한이 있는 GitHub 토큰으로 로그인해 주세요.</p>
        <label>저장소 (아이디/저장소이름)<input name="repo" required value="${esc(guessRepo())}" placeholder="예: myid/sungdo-night-2026"></label>
        <label>GitHub 토큰<input name="token" type="password" required autocomplete="off" placeholder="github_pat_…"></label>
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
  const ev = orig || { id: uid(), date, type: '촬영', title: '', start: '09:00', end: '12:00', location: '', people: [], extra: '', memo: '', supplies: [], scenes: [] };
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
        <label>장소<input name="location" value="${esc(ev.location)}" placeholder="예: 본당 2층 소예배실"></label>
        <fieldset>
          <legend>참여 인원</legend>
          ${cast.length || staff.length
            ? `${cast.length ? `<div><div class="pick-label">배역</div><div class="picks">${picks(cast)}</div></div>` : ''}
               ${staff.length ? `<div><div class="pick-label">스태프</div><div class="picks">${picks(staff)}</div></div>` : ''}`
            : '<p class="hint">왼쪽 ‘촬영 인원’ 메뉴에서 배역과 스태프를 먼저 등록하면 여기서 고를 수 있습니다.</p>'}
          <label>그 외 인원<input name="extra" value="${esc(ev.extra)}" placeholder="예: 보조 출연 3명"></label>
        </fieldset>
        <fieldset>
          <legend>공통 준비물 <small>(씬별 소품은 씬에서 따로 넣습니다)</small></legend>
          ${itemsEditorHTML('evItems', ev.supplies || [])}
        </fieldset>
        <label>메모<textarea name="memo" rows="3" placeholder="집합 시간, 주의 사항 등">${esc(ev.memo)}</textarea></label>
      </div>
      <div class="m-foot">
        <button type="button" class="btn" data-act="close-modal">취소</button>
        <button class="btn primary">확인</button>
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
      location: f.get('location').trim(), people: f.getAll('people'), extra: f.get('extra').trim(), memo: f.get('memo').trim(),
      supplies: readItems('evItems', ev.supplies || []),
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
    : { id: uid(), time: ev.start || '', no: `S#${ev.scenes.length + 1}`, title: '', desc: '', location: '', cast: [], props: [], images: [] };
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
        <label>촬영 장소<input name="location" value="${esc(s.location)}" placeholder="${esc(ev.location ? `비워 두면 일정 장소(${ev.location})` : '예: 교회 식당')}"></label>
        <label>간단 설명<textarea name="desc" rows="2" placeholder="한두 줄로 적어 주세요">${esc(s.desc)}</textarea></label>
        ${castPicks ? `<fieldset><legend>등장 배역</legend><div class="picks">${castPicks}</div></fieldset>` : ''}
        <fieldset>
          <legend>이 씬의 준비물·소품</legend>
          ${itemsEditorHTML('scItems', s.props)}
        </fieldset>
        <fieldset>
          <legend>콘티 이미지 <small>(위에서부터 순서대로 보여집니다)</small></legend>
          <div class="img-list" id="imgList"></div>
          <label class="upload"><input type="file" accept="image/*" multiple id="imgInput"><span>＋ 이미지 추가 (여러 장 선택 가능)</span></label>
          <div class="hint" id="upStatus"></div>
        </fieldset>
      </div>
      <div class="m-foot">
        ${orig ? '<button type="button" class="btn danger left" id="delScene">씬 삭제</button>' : ''}
        <button type="button" class="btn" data-act="close-modal">취소</button>
        <button class="btn primary" id="scSave">확인</button>
      </div>
    </form>`);

  const list = $('#imgList');
  const draw = () => {
    list.innerHTML = s.images.length
      ? s.images.map((im, j) => `
        <div class="img-item">
          <span class="img-n">${j + 1}</span>
          <img src="${esc(imgSrc(im.src))}" alt="컷 ${j + 1}">
          <input class="img-cap" data-j="${j}" value="${esc(im.cap || '')}" placeholder="컷 설명 (선택)" aria-label="컷 ${j + 1} 설명">
          <div class="img-tools">
            <button type="button" class="mini" data-mv="${j}|-1" ${j === 0 ? 'disabled' : ''} aria-label="앞으로">↑</button>
            <button type="button" class="mini" data-mv="${j}|1" ${j === s.images.length - 1 ? 'disabled' : ''} aria-label="뒤로">↓</button>
            <button type="button" class="mini danger" data-rm="${j}" aria-label="삭제">✕</button>
          </div>
        </div>`).join('')
      : '<div class="empty sm">아직 이미지가 없습니다.</div>';
  };
  draw();
  list.oninput = (e) => { if (e.target.matches('.img-cap')) s.images[+e.target.dataset.j].cap = e.target.value; };
  list.onclick = (e) => {
    const mv = e.target.closest('[data-mv]');
    const rm = e.target.closest('[data-rm]');
    if (mv) {
      const [j, d] = mv.dataset.mv.split('|').map(Number);
      const [item] = s.images.splice(j, 1);
      s.images.splice(j + d, 0, item);
      draw();
    } else if (rm) {
      s.images.splice(+rm.dataset.rm, 1);
      draw();
    }
  };
  $('#imgInput').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const status = $('#upStatus');
    const saveBtn = $('#scSave');
    saveBtn.disabled = true;
    for (const [n, file] of files.entries()) {
      status.textContent = `이미지 ${state.localOnly ? '처리' : '업로드'} 중… (${n + 1}/${files.length})`;
      try {
        const dataUrl = await compress(file);
        let src = dataUrl;
        if (!state.localOnly) {
          src = await uploadImage(dataUrl);
          state.imgCache[src] = dataUrl;
        }
        s.images.push({ src, cap: '' });
        draw();
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 4000);
      }
    }
    status.textContent = state.localOnly
      ? '임시 편집: 이미지가 data.json 안에 함께 저장됩니다.'
      : '이미지를 저장소에 올렸습니다. ‘확인’ 후 상단의 ‘저장’을 눌러 주세요.';
    saveBtn.disabled = false;
  };
  $('#delScene')?.addEventListener('click', () => {
    if (!confirm(`${orig.no} ${orig.title} 씬을 삭제할까요?`)) return;
    ev.scenes = ev.scenes.filter((x) => x.id !== orig.id);
    markDirty(); closeModal(); render();
  });
  $('#scForm').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    Object.assign(s, {
      time: f.get('time'), no: f.get('no').trim(), title: f.get('title').trim(), desc: f.get('desc').trim(),
      location: f.get('location').trim(), cast: f.getAll('cast'), props: readItems('scItems', s.props),
    });
    if (orig) Object.assign(orig, s); else ev.scenes.push(s);
    markDirty(); closeModal(); render();
  };
}

/* ---------- 이벤트 처리 ---------- */
function openDay(k) { state.openDate = k; renderDrawer(); }
function switchScene(id) {
  state.viewer.sceneId = id;
  renderViewer();
  $('#vScroll')?.scrollTo(0, 0);
}
function goto(k) {
  state.view = 'calendar';
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

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act],[data-add],[data-edit-ev],[data-del-ev],[data-add-scene],[data-edit-scene],[data-scene],[data-vjump],[data-vscene],[data-goto],[data-view],[data-add-p],[data-del-p],[data-toggle],[data-add-item],[data-rm-item],[data-day]');
  if (!t) return;
  const d = t.dataset;

  if (d.addItem) {
    const box = $(`#${d.addItem}`);
    box.insertAdjacentHTML('beforeend', itemRowHTML({ id: uid(), name: '', owner: '' }));
    $$('.it-name', box).pop().focus();
    return;
  }
  if (d.rmItem !== undefined) { t.closest('.item-row')?.remove(); return; }
  if (d.toggle) {
    const it = findItem(d.toggle);
    if (it && state.admin) {
      it.done = !it.done;
      markDirty();
      const main = $('#main .people');
      const sc = main?.scrollTop || 0;
      render();
      if ($('#main .people')) $('#main .people').scrollTop = sc;
    }
    return;
  }
  if (d.vjump !== undefined) { $(`#vcut-${d.vjump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }

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
      case 'close-modal': closeModal(); break;
      case 'set-link': openLinkModal(state.view); break;
      case 'local-edit':
        state.admin = true; state.localOnly = true; state.gh = null;
        closeModal(); render();
        toast('임시 편집 모드입니다. 수정 후 ‘data.json 받기’로 파일을 내려받아 저장소에 올려 주세요.', 5000);
        break;
    }
    return;
  }
  if (d.view) { state.view = d.view; render(); return; }
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
  if (d.scene) { const [a, b] = d.scene.split('|'); state.viewer = { evId: a, sceneId: b }; renderViewer(); $('#vScroll')?.scrollTo(0, 0); return; }
  if (d.vscene) { if (state.viewer) { switchScene(d.vscene); } return; }
  if (d.addP) {
    state.data[d.addP].push({ id: uid(), role: '', name: '' });
    markDirty(); render();
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
    markDirty(); render();
    return;
  }
  if (d.day) { openDay(d.day); }
});

document.addEventListener('input', (e) => {
  const p = e.target.dataset?.p;
  if (!p) return;
  const [kind, id, field] = p.split('|');
  const person = state.data[kind].find((x) => x.id === id);
  if (person) { person[field] = e.target.value; markDirty(); }
});
document.addEventListener('change', (e) => { if (e.target.dataset?.p) renderSide(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (modalOpen()) closeModal();
    else if (state.viewer) { state.viewer = null; renderViewer(); }
    else if (state.openDate) { state.openDate = null; renderDrawer(); }
    return;
  }
  if (state.viewer && !modalOpen() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const id = $(`#viewer [data-vscene]:${e.key === 'ArrowLeft' ? 'first' : 'last'}-of-type`)?.dataset.vscene;
    if (id) switchScene(id);
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-day]')) {
    e.preventDefault();
    openDay(e.target.dataset.day);
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
