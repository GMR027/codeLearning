const vscode = acquireVsCodeApi();
const chat = document.getElementById('chat');
const model = document.getElementById('model');
const warn = document.getElementById('ghostWarn');
const hero = document.getElementById('hero');
const statusText = document.getElementById('statusText');
const source = document.getElementById('source');

/** Markdown mínimo y seguro (todo con textContent): bloques de código, listas, citas, **negrita** y `código`. */
function inline(parent, text) {
  text.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/).forEach((t) => {
    if (!t) return;
    let el;
    if (t.startsWith('**')) { el = document.createElement('strong'); el.textContent = t.slice(2, -2); }
    else if (t.startsWith('`')) { el = document.createElement('code'); el.textContent = t.slice(1, -1); }
    else if (t.length > 2 && t.startsWith('_') && t.endsWith('_')) { el = document.createElement('em'); el.textContent = t.slice(1, -1); }
    else el = document.createTextNode(t);
    parent.appendChild(el);
  });
}

let pending = null;

function add(text, isPending) {
  pending?.remove();
  pending = null;
  const div = document.createElement('div');
  div.className = 'msg';
  if (/^_.*…_$/.test(String(text).trim())) div.classList.add('status-msg');
  String(text).split(/```/).forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part.replace(/^\w*\n/, '').replace(/\n$/, '');
      pre.appendChild(code);
      div.appendChild(pre);
      return;
    }
    let list = null;
    part.split(/\n{2,}|\n(?=[-*] )/).forEach((block) => {
      block = block.trim();
      if (!block) return;
      if (/^[-*] /.test(block)) {
        if (!list) { list = document.createElement('ul'); div.appendChild(list); }
        const li = document.createElement('li');
        inline(li, block.slice(2));
        list.appendChild(li);
        return;
      }
      list = null;
      const quote = block.startsWith('>');
      const el = document.createElement(quote ? 'blockquote' : 'p');
      inline(el, quote ? block.replace(/^>\s?/gm, '') : block);
      div.appendChild(el);
    });
  });
  chat.querySelector('.hint')?.remove();
  chat.appendChild(div);
  if (isPending) pending = div;
  chat.scrollTop = chat.scrollHeight;
}

const orb = document.getElementById('orb');
const orbLabel = document.getElementById('orbLabel');
const pathInput = document.getElementById('pathInput');
const btnAnalyze = document.getElementById('btnAnalyze');
const result = document.getElementById('result');
const analyze = () => { if (pathInput.value.trim()) vscode.postMessage({ type: 'analyze', value: pathInput.value }); };
btnAnalyze.addEventListener('click', analyze);
pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });
document.getElementById('btnBrowse').addEventListener('click', () => vscode.postMessage({ type: 'browse' }));
document.getElementById('btnWorkspace').addEventListener('click', () => vscode.postMessage({ type: 'workspace' }));
document.getElementById('btnClearCache').addEventListener('click', () => vscode.postMessage({ type: 'clearCache' }));

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Modelo que cabe en esta RAM (pesos cuantizados + margen para el sistema); la GPU no se tiene en cuenta. */
function suggestModel(ramGb) {
  if (ramGb >= 48) return { name: 'qwen2.5-coder:32b', gb: 20 };
  if (ramGb >= 32) return { name: 'qwen2.5-coder:14b', gb: 9 };
  if (ramGb >= 12) return { name: 'qwen2.5-coder:7b', gb: 4.7 };
  return undefined;
}

function renderNotesModel(s) {
  const box = document.getElementById('notesBox');
  const sel = document.getElementById('setNotesModel');
  const hint = document.getElementById('notesHint');
  const btn = document.getElementById('btnPullSuggest');
  box.hidden = s.settings.backend === 'opencode';
  sel.replaceChildren(new Option('Igual que el análisis', ''));
  const ram = s.hw ? s.hw.ramGb : 0;
  const installed = s.installed || [];
  installed.filter((m) => !/base|embed|fim|starcoder/i.test(m.name)).sort((a, b) => b.size - a.size).forEach((m) => {
    const gb = m.size / 1e9;
    const fits = !ram || gb * 1.5 + 3 <= ram;
    sel.append(new Option(m.name + ' · ' + gb.toFixed(1) + ' GB' + (fits ? '' : ' · ⚠ puede no caber en tu RAM'), m.name));
  });
  if (s.settings.notesModel && !installed.some((m) => m.name === s.settings.notesModel)) sel.append(new Option(s.settings.notesModel + ' · sin instalar', s.settings.notesModel));
  sel.value = s.settings.notesModel || '';
  const sug = suggestModel(ram);
  const have = sug && installed.some((m) => m.name === sug.name);
  hint.textContent = !ram ? '' : sug
    ? 'Tu equipo tiene ' + ram + ' GB de RAM: puede con ' + sug.name + ' (~' + sug.gb + ' GB). Un modelo mayor escribe mejores notas, pero tarda más por lección (sin tarjeta gráfica dedicada, bastante más).'
    : 'Tu equipo tiene ' + ram + ' GB de RAM: con modelos de 3B o menos va bien; uno mayor iría muy lento.';
  btn.hidden = !sug || have || s.installed === null;
  if (sug) { btn.textContent = 'Descargar ' + sug.name; btn.dataset.model = sug.name; }
}

function renderModels(s) {
  renderNotesModel(s);
  setModelSel.replaceChildren();
  if (s.installed === null) {
    setModelSel.append(new Option('Ollama no responde — ¿está encendido?', ''));
  } else {
    const names = s.installed.map((m) => m.name);
    if (s.settings.model && !names.includes(s.settings.model)) names.unshift(s.settings.model);
    if (!names.length) setModelSel.append(new Option('No hay modelos: descarga uno abajo', ''));
    names.forEach((n) => {
      const m = s.installed.find((x) => x.name === n);
      const gb = m ? ' · ' + (m.size / 1e9).toFixed(1) + ' GB' : ' · sin instalar';
      setModelSel.append(new Option(n + gb + (m && m.loaded ? ' · cargado' : ''), n));
    });
    setModelSel.value = s.settings.model || names.find((n) => !/base/.test(n)) || '';
  }
  if (document.activeElement !== setOcModel) setOcModel.value = s.settings.ocModel;
  const dl = document.getElementById('ocModels');
  dl.replaceChildren(...s.opencode.models.map((n) => new Option(n)));
  document.getElementById('ocStatus').textContent = s.opencode.found
    ? 'OpenCode detectado.' + (s.opencode.models.length ? '' : ' Configura un proveedor con «opencode auth login» para ver modelos.')
    : 'No se encontró el comando «opencode». Instálalo desde opencode.ai.';
}

let lastReqs = null;
let reqsBusy = false;

function updateStart() {
  const go = document.getElementById('btnStart');
  if (!go) return;
  const missing = lastReqs ? lastReqs.items.filter((r) => !r.installed).length : 1;
  go.disabled = missing > 0;
  go.title = lastReqs ? (missing ? 'Instala primero los ' + missing + ' requisito(s) que faltan' : '') : 'Comprobando requisitos…';
}

function renderReqs() {
  updateStart();
  const box = document.getElementById('reqsBox');
  if (!box || !lastReqs) return;
  const { items, bulk } = lastReqs;
  box.replaceChildren();
  if (!items.length) return;
  const missing = items.filter((r) => !r.installed);
  const ok = items.filter((r) => r.installed);

  box.append(el('h2', 'sec', 'Requisitos para desarrollar'));
  if (!missing.length) {
    box.append(el('p', 'note ready', 'Listo para desarrollar: todo está instalado.'));
  } else {
    box.append(el('p', 'note warn', 'Faltan ' + missing.length + ' de ' + items.length + '. Instálalos antes de seguir el plan.'));
    const list = el('div', 'reqlist');
    missing.forEach((r) => {
      const row = el('div', 'req');
      const info = el('div', 'grow');
      const nm = el('div', 'req-name');
      nm.append(el('strong', '', r.name), el('span', 'chip plain', r.scope === 'project' ? 'proyecto' : 'equipo'));
      info.append(nm, el('span', 'muted', r.why));
      const acts = el('div', 'req-acts');
      r.options.forEach((o, i) => {
        const b = el('button', 'btn ghost sm', o.label + (o.link ? ' ↗' : ''));
        b.title = o.command;
        b.disabled = reqsBusy && !o.link;
        b.addEventListener('click', () => vscode.postMessage({ type: 'install', id: r.id, opt: i }));
        acts.append(b);
      });
      if (!r.options.length) acts.append(el('span', 'muted', 'instalación manual'));
      row.append(info, acts);
      list.append(row);
    });
    box.append(list);
    const bar = el('div', 'row-btns');
    if (bulk) {
      const all = el('button', 'btn', 'Instalar todas las dependencias');
      all.disabled = reqsBusy;
      all.addEventListener('click', () => vscode.postMessage({ type: 'installAll' }));
      bar.append(all);
    }
    const re = el('button', 'btn ghost', 'Comprobar de nuevo');
    re.addEventListener('click', () => vscode.postMessage({ type: 'recheck' }));
    bar.append(re);
    box.append(bar);
    if (reqsBusy) box.append(el('p', 'muted', 'Instalando en la terminal «Code Learning»… se comprueba solo cada 5 s.'));
  }
  if (ok.length) {
    const d = document.createElement('details');
    d.open = !missing.length;
    d.append(el('summary', '', 'Instalados y listos (' + ok.length + ')'));
    const tags = el('div', 'tags');
    ok.forEach((r) => { const c = el('span', 'chip plain ok', r.name + (r.version ? ' · ' + r.version : '')); c.title = r.why; tags.append(c); });
    d.append(tags);
    box.append(d);
  }
}

function renderLearning(m) {
  const n = document.getElementById('learnNote');
  if (!n) return;
  n.replaceChildren();
  n.hidden = false;
  if (m.error) { n.append(el('p', 'note warn', 'No se pudo crear learning/: ' + m.error)); return; }
  if (m.noFolder) { n.append(el('p', 'note warn', 'Abre una carpeta de trabajo para que se cree learning/ con el temario.')); return; }
  if (m.written.length) n.append(el('p', 'note ready', 'Se creó learning/ con ' + m.written.join(' y ') + '.'));
  if (m.skipped.length) n.append(el('p', 'note warn', 'No se tocó ' + m.skipped.join(', ') + ': ya existe y no lo creó Code Learning.'));
  const bar = el('div', 'row-btns');
  [['temario.md', 'Abrir temario'], ['plan-de-estudios.md', 'Abrir plan']].forEach(([f, label]) => {
    const b = el('button', 'btn ghost', label);
    b.addEventListener('click', () => vscode.postMessage({ type: 'openLearning', value: f }));
    bar.append(b);
  });
  n.append(bar);
}

function renderResult(a) {
  result.replaceChildren();
  const head = el('article', 'card');
  const top = el('div', 'card-top');
  top.append(el('span', 'name', a.name), el('span', 'chip', a.source === 'ai' ? 'IA' : 'básico'));
  head.append(top, el('span', 'meta', a.type + ' · ' + a.files + ' archivos'), el('p', 'note', a.summary));
  result.append(head);

  const pf = a.profile;
  if (pf) {
    const rows = [
      ['Lenguajes', pf.languages.join(', ')], ['Framework', pf.framework], ['Arquitectura', pf.architecture], ['Entrada', pf.entry],
      ['Servicios', pf.services.join(', ')], ['Variables', pf.env.length ? pf.env.slice(0, 8).join(', ') + (pf.env.length > 8 ? '…' : '') : ''],
      ['Scripts', pf.scripts.slice(0, 5).map((x) => x.name).join(', ')],
    ].filter((r) => r[1]);
    if (rows.length) {
      const dl = el('dl', 'profile');
      rows.forEach(([k, v]) => dl.append(el('dt', '', k), el('dd', '', v)));
      result.append(el('h2', 'sec', 'Qué se detectó'), dl);
    }
    pf.warnings.forEach((w) => result.append(el('p', 'note warn', w)));
  }

  if (a.topics.length) {
    result.append(el('h2', 'sec', 'Temas del proyecto'));
    const tags = el('div', 'tags');
    a.topics.forEach((t) => { const c = el('span', 'chip plain', t.name); if (t.description) c.title = t.description; tags.append(c); });
    result.append(tags);
  }

  result.append(el('section', 'reqs', ''));
  result.querySelector('.reqs').id = 'reqsBox';
  result.append(el('h2', 'sec', 'Plan de estudio'));
  if (a.startHere) result.append(el('p', 'note start', 'Empieza por: ' + a.startHere));
  const ol = el('ol', 'plan');
  a.plan.forEach((p) => {
    const li = el('li');
    li.append(el('strong', '', p.title), el('span', 'muted', p.description));
    if (p.files.length) li.append(el('code', 'files', p.files.join(' · ')));
    ol.append(li);
  });
  result.append(ol);

  const note = el('div', 'learn-note');
  note.id = 'learnNote';
  note.hidden = true;
  result.append(note);
  const go = el('button', 'btn wide', 'Comenzar');
  go.id = 'btnStart';
  go.addEventListener('click', () => vscode.postMessage({ type: 'start' }));
  result.append(go);
  updateStart();
  result.hidden = false;
}

function setOrb(status, text) {
  orb.className = 'book-orb ' + status;
  orbLabel.textContent = text;
  const busy = status === 'working';
  btnAnalyze.disabled = busy;
  ['btnBrowse', 'btnWorkspace'].forEach((id) => { document.getElementById(id).disabled = busy; });
}

document.getElementById('btnExplain').addEventListener('click', () => vscode.postMessage({ type: 'explain' }));
document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
['btnInstall', 'btnInstall2'].forEach((id) =>
  document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: 'installGhostcode' })));

function showTab(tab) {
  document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === tab)));
  document.querySelectorAll('.page').forEach((p) => { p.hidden = p.id !== 'page-' + tab; });
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

const setBackend = document.getElementById('setBackend');
const setModelSel = document.getElementById('setModelSel');
const setOcModel = document.getElementById('setOcModel');
const setBackendChange = () => { document.querySelectorAll('[data-for]').forEach((n) => { n.hidden = n.dataset.for !== setBackend.value; }); document.getElementById('notesBox').hidden = setBackend.value === 'opencode'; };
document.getElementById('btnPull').addEventListener('click', () => {
  const v = document.getElementById('pullName').value.trim();
  if (v) vscode.postMessage({ type: 'pull', value: v });
});
document.getElementById('btnTest').addEventListener('click', () => vscode.postMessage({ type: 'testAi' }));
document.getElementById('btnExport').addEventListener('click', () => vscode.postMessage({ type: 'exportProgress' }));
document.getElementById('setNotesModel').addEventListener('change', (e) => save('notesModel', e.target.value));
document.getElementById('btnPullSuggest').addEventListener('click', (e) => { const m = e.target.dataset.model; if (m) vscode.postMessage({ type: 'pull', value: m }); });
setModelSel.addEventListener('change', () => save('local.model', setModelSel.value));
setOcModel.addEventListener('change', () => save('opencode.model', setOcModel.value.trim()));
const setUrl = document.getElementById('setUrl');
const save = (key, value) => vscode.postMessage({ type: 'setConfig', key, value });
setBackend.addEventListener('change', () => { setBackendChange(); save('backend', setBackend.value); });
setUrl.addEventListener('change', () => save('local.url', setUrl.value.trim()));
const setLevel = document.getElementById('setLevel');
const setLanguage = document.getElementById('setLanguage');
setLevel.addEventListener('change', () => save('level', setLevel.value));
setLanguage.addEventListener('change', () => save('language', setLanguage.value));

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'answer') add(m.text);
  else if (m.type === 'pending') add(m.text, true);
  else if (m.type === 'requirements') { lastReqs = m; renderReqs(); }
  else if (m.type === 'requirements-busy') { reqsBusy = true; renderReqs(); }
  else if (m.type === 'requirements-idle') { reqsBusy = false; renderReqs(); }
  else if (m.type === 'learning') renderLearning(m);
  else if (m.type === 'lesson') renderLesson(m);
  else if (m.type === 'chart') renderChart(m);
  else if (m.type === 'ghost') renderGhost(m);
  else if (m.type === 'lessonError') showLessonError(m.text);
  else if (m.type === 'showTab') showTab(m.tab);
  else if (m.type === 'pull') { document.getElementById('pullStatus').textContent = m.text; document.getElementById('pullStatus2').textContent = m.text; }
  else if (m.type === 'test') {
    const t = document.getElementById('testStatus');
    t.textContent = m.text;
    t.style.color = m.ok === true ? 'var(--ok)' : m.ok === false ? 'var(--warn)' : '';
  }
  else if (m.type === 'analysis') {
    if (m.path && document.activeElement !== pathInput) pathInput.value = m.path;
    if (m.status === 'working') { lastReqs = null; reqsBusy = false; }
    if (m.status === 'working') setOrb('working', 'Analizando: ' + m.text);
    else if (m.status === 'ready') { setOrb('ready', 'Análisis listo'); renderResult(m.data); }
    else if (m.status === 'error') setOrb('idle', 'Error: ' + m.text);
    else setOrb('idle', 'Elige la carpeta de un proyecto para analizarlo');
  }
  else if (m.type === 'state') {
    try {
      const s = JSON.parse(m.text);
      model.textContent = s.model;
      source.textContent = s.source;
      source.hidden = false;
      statusText.textContent = s.ghostInstalled ? 'GhostCode detectado' : 'Modelo propio';
      hero.classList.toggle('on', !!s.ghostInstalled);
      hero.classList.toggle('warn-state', !s.ghostInstalled);
      warn.hidden = !!s.ghostInstalled;
      if (s.ghost) renderGhost({ connected: s.ghost.connected });
      if (s.settings) {
        setBackend.value = s.settings.backend;
        setBackendChange();
        document.getElementById('resolved').textContent = 'Se usará: ' + s.model + ' (' + s.source + ')';
        renderModels(s);
        setLevel.value = s.settings.level;
        setLanguage.value = s.settings.language;
        if (!pathInput.value && s.workspace) pathInput.value = s.workspace;
        if (document.activeElement !== setUrl) setUrl.value = s.settings.url;
      }
    } catch { /* estado simple */ }
  }
});

/* --- Conectar con GhostCode (Halo IA) ---------------------------------------------------- */
const btnGhost = document.getElementById('btnGhost');
const ghostMsg = document.getElementById('ghostMsg');
btnGhost.addEventListener('click', () => { if (!btnGhost.disabled) vscode.postMessage({ type: 'ghostToggle' }); });
let ghostTimer = 0;
function renderGhost(g) {
  btnGhost.classList.toggle('on', !!g.connected);
  btnGhost.classList.toggle('busy', !!g.busy);
  btnGhost.setAttribute('aria-pressed', String(!!g.connected));
  btnGhost.disabled = !!g.busy;
  btnGhost.querySelector('.tri-label').textContent = g.connected ? 'Conectado con GhostCode' : 'Conectar con GhostCode';
  clearTimeout(ghostTimer);
  ghostMsg.hidden = !g.text;
  ghostMsg.textContent = g.text || '';
  if (g.text && !g.busy) ghostTimer = setTimeout(() => { ghostMsg.hidden = true; }, 6000);
}

/* --- Gráfico de anillos: un anillo por tema, el arco es el avance ------------------------ */
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs, parent) => {
  const n = document.createElementNS(NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
  if (parent) parent.append(n);
  return n;
};
/** Pares de colores (inicio, fin) del degradado de cada anillo: violeta, rosa, rojo-naranja… */
const RING_COLORS = [['#7c3aed', '#c026d3'], ['#ec4899', '#fb7185'], ['#f97316', '#fbbf24'], ['#0ea5e9', '#22d3ee'], ['#16a34a', '#84cc16'], ['#6366f1', '#a78bfa']];
const SWEEP = 270;

function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}
function arc(cx, cy, r, deg) {
  const [x0, y0] = polar(cx, cy, r, 0);
  const [x1, y1] = polar(cx, cy, r, deg);
  return 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (deg > 180 ? 1 : 0) + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2);
}

function renderChart(m) {
  const box = document.getElementById('chart');
  if (!box) return;
  box.replaceChildren();
  if (!m.topics.length) { box.append(el('p', 'muted', 'Analiza un proyecto para ver tu avance por temas.')); return; }
  const topics = m.topics.slice(0, 6);
  const cx = 150, cy = 150, inner = 38, outer = 132;
  const pitch = Math.min(22, (outer - inner) / topics.length);
  const w = pitch - 4;
  const root = svg('svg', { viewBox: '0 0 300 300', class: 'ring-chart', role: 'img', 'aria-label': 'Avance por temas' });
  const defs = svg('defs', {}, root);
  topics.forEach((_, i) => {
    const [c1, c2] = RING_COLORS[i % RING_COLORS.length];
    const g = svg('linearGradient', { id: 'rg' + i, x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
    svg('stop', { offset: '0', 'stop-color': c1 }, g);
    svg('stop', { offset: '1', 'stop-color': c2 }, g);
  });
  // Disco suave de fondo, como en la plantilla.
  svg('circle', { cx, cy, r: outer + 14, class: 'ring-bg' }, root);

  topics.forEach((t, i) => {
    // El primer tema va en el anillo exterior.
    const r = outer - i * pitch - w / 2;
    svg('path', { d: arc(cx, cy, r, SWEEP), class: 'ring-track', 'stroke-width': w }, root);
    if (t.pct > 0) svg('path', { d: arc(cx, cy, r, (SWEEP * t.pct) / 100), stroke: 'url(#rg' + i + ')', 'stroke-width': w, class: 'ring-fill' }, root);
    // Etiqueta a la izquierda del inicio (arriba), con el avance debajo.
    const ty = cy - r;
    const name = svg('text', { x: cx - 8, y: ty + 3, class: 'ring-label', 'text-anchor': 'end' }, root);
    name.textContent = t.name.length > 22 ? t.name.slice(0, 21) + '…' : t.name;
    name.style.fill = RING_COLORS[i % RING_COLORS.length][0];
    const sub = svg('text', { x: cx - 8, y: ty + 3 + 9, class: 'ring-sub', 'text-anchor': 'end' }, root);
    sub.textContent = t.done + '/' + t.total + ' · ' + t.pct + '%';
    // Insignia numerada al final del anillo.
    const [bx, by] = polar(cx, cy, r, SWEEP);
    svg('circle', { cx: bx, cy: by, r: Math.max(6, w / 2 + 1), fill: 'url(#rg' + i + ')', class: 'ring-badge' }, root);
    const num = svg('text', { x: bx, y: by + 3, class: 'ring-num', 'text-anchor': 'middle' }, root);
    num.textContent = String(i + 1);
  });

  svg('circle', { cx, cy, r: inner, class: 'ring-center' }, root);
  const pct = svg('text', { x: cx, y: cy + 2, class: 'ring-pct', 'text-anchor': 'middle' }, root);
  pct.textContent = m.overall + '%';
  const lab = svg('text', { x: cx, y: cy + 17, class: 'ring-sub', 'text-anchor': 'middle' }, root);
  lab.textContent = 'avance';
  box.append(root);

  const legend = el('ul', 'ring-legend');
  topics.forEach((t, i) => {
    const li = el('li');
    const sw = el('span', 'sw');
    sw.style.background = 'linear-gradient(135deg,' + RING_COLORS[i % RING_COLORS.length].join(',') + ')';
    li.append(sw, el('span', 'grow', (i + 1) + '. ' + t.name), el('span', 'muted', t.done + '/' + t.total + ' lecciones · ' + t.pct + '%'));
    legend.append(li);
  });
  box.append(legend);
}

/* --- Pestaña Learning --------------------------------------------------------- */
let helpOpen = false;
let helpDraft = '';
let lessonErr = '';

function showLessonError(text) {
  lessonErr = text;
  const box = document.getElementById('lessonErr');
  if (box) { box.textContent = text; box.hidden = !text; }
}

function renderLesson(s) {
  const empty = document.getElementById('lessonEmpty');
  const view = document.getElementById('lessonView');
  empty.hidden = !!s.started;
  view.hidden = !s.started;
  if (!s.started) return;
  const keepScroll = view.scrollTop;
  view.replaceChildren();
  const busy = !!s.busy;
  const L = s.lesson;
  const go = (type, value) => vscode.postMessage({ type, value });

  // Progreso y navegación entre lecciones.
  const done = s.status.filter((x) => x === 'done').length;
  const head = el('div', 'lesson-head');
  head.append(el('span', 'muted', 'Lección ' + (s.current + 1) + ' de ' + s.total + ' · ' + done + ' completadas'));
  const bar = el('div', 'progress');
  const fill = el('span');
  fill.style.width = Math.round((done / s.total) * 100) + '%';
  bar.append(fill);
  const dots = el('div', 'dots');
  s.titles.forEach((t, i) => {
    const d = el('button', 'dot-btn ' + s.status[i] + (i === s.current ? ' cur' : ''), String(i + 1));
    d.title = t + (s.broken && s.broken.includes(i) ? ' — dejó de cumplirse' : '');
    if (s.broken && s.broken.includes(i)) d.classList.add('broken');
    d.disabled = busy || i > s.unlocked;
    d.addEventListener('click', () => go('lessonOpen', i));
    dots.append(d);
  });
  const fmt = (m) => { const r = Math.max(1, Math.round(m)); return r < 60 ? r + ' min' : Math.floor(r / 60) + ' h' + (r % 60 ? ' ' + (r % 60) + ' min' : ''); };
  const info = [];
  if (s.time && !s.review) {
    info.push('⏱ ≈ ' + fmt(s.time.thisMin) + ' esta lección');
    if (s.time.remainingMin > 1) info.push('≈ ' + fmt(s.time.remainingMin) + ' para terminar' + (s.time.paced ? ' (a tu ritmo)' : ''));
  }
  if (s.streak) info.push(s.streak.current > 0 ? '🔥 racha de ' + s.streak.current + (s.streak.current === 1 ? ' día' : ' días') + (s.streak.best > s.streak.current ? ' (mejor: ' + s.streak.best + ')' : '') : 'Sin racha: estudia hoy para empezar una' + (s.streak.best ? ' (mejor: ' + s.streak.best + ')' : ''));
  view.append(head, bar, dots);
  if (info.length) view.append(el('p', 'muted study-info', info.join(' · ')));

  if (s.review) view.append(el('p', 'note', 'Estás repasando el avance guardado en learning/progreso.json (proyecto ' + s.foreign + '). Para seguir con las lecciones, analiza ese proyecto en Start.'));
  const err = el('p', 'note warn');
  err.id = 'lessonErr';
  err.textContent = lessonErr;
  err.hidden = !lessonErr;
  view.append(err);

  if (busy) view.append(el('p', 'note working', '⏳ ' + s.busy));
  if (!L || !L.content) return;
  const C = L.content;

  view.append(el('h2', 'lesson-title', 'Lección ' + (s.current + 1) + ': ' + C.title));

  const obj = el('section', 'lsec');
  obj.append(el('h3', '', 'Objetivo'), el('p', '', C.objective));
  if (C.topics.length) { const t = el('div', 'tags'); C.topics.forEach((x) => t.append(el('span', 'chip plain', x))); obj.append(t); }
  if (C.scope) obj.append(el('p', 'muted', 'Alcance: ' + C.scope));
  view.append(obj);

  const code = el('section', 'lsec');
  code.append(el('h3', '', 'Código'), el('p', 'muted', 'Escríbelo tú en ' + (s.base === '.' ? 'la carpeta abierta' : s.base + '/') + ' — los comentarios explican cada sección.'));
  C.blocks.forEach((b) => {
    const row = el('div', 'file-row');
    row.append(el('code', 'grow', b.file + (b.total > b.to - b.from + 1 ? ' · líneas ' + b.from + '–' + b.to + ' de ' + b.total : '')));
    const open = el('button', 'btn ghost sm', 'Abrir archivo');
    open.addEventListener('click', () => go('lessonOpenFile', b.file));
    row.append(open);
    const pre = el('pre');
    pre.append(el('code', '', b.display));
    code.append(row, pre);
    if (b.notes && b.notes.length) {
      const ul = el('ul', 'notes');
      b.notes.forEach((n) => ul.append(el('li', '', 'Línea ' + n.line + ': ' + n.text)));
      code.append(el('p', 'muted', 'Qué hace cada parte:'), ul);
    }
  });
  view.append(code);

  if (C.commands && C.commands.length) {
    const term = el('section', 'lsec');
    term.append(el('h3', '', 'Terminal'), el('p', 'muted', 'Ejecuta estos comandos en la carpeta del proyecto cuando termines de escribir el código.'));
    C.commands.forEach((c, i) => {
      const row = el('div', 'cmd-row');
      const txt = el('div', 'grow');
      txt.append(el('code', 'cmd', c.cmd), el('span', 'muted', c.why));
      const run = el('button', 'btn ghost sm', 'Ejecutar');
      run.title = 'Abre la terminal y ejecuta el comando';
      run.addEventListener('click', () => go('lessonRun', i));
      row.append(txt, run);
      term.append(row);
    });
    view.append(term);
  }

  const chk = el('section', 'lsec');
  chk.append(el('h3', '', 'Comprobación'));
  const ol = el('ol', 'checks');
  (C.checks.length ? C.checks : ['Ejecuta el proyecto y comprueba que se comporta como el original.']).forEach((x) => ol.append(el('li', '', x)));
  chk.append(ol);
  view.append(chk);

  // Botones.
  const isDone = L.status === 'done';
  if (s.review) {
    const nav = el('div', 'row-btns lesson-btns');
    const pv = el('button', 'btn ghost', '←');
    pv.disabled = s.current === 0;
    pv.addEventListener('click', () => go('lessonOpen', s.current - 1));
    const nx = el('button', 'btn ghost', '→');
    nx.disabled = s.current >= s.total - 1;
    nx.addEventListener('click', () => go('lessonOpen', s.current + 1));
    nav.append(pv, nx);
    view.append(nav);
    if (isDone) view.append(el('p', 'note ready', '¡Lección completada!'));
    return;
  }
  const st = isDone ? 'ok' : (L.last ? L.last.state : '');
  const btns = el('div', 'row-btns lesson-btns');
  const prev = el('button', 'btn ghost', '←');
  prev.title = 'Lección anterior';
  prev.disabled = busy || s.current === 0;
  prev.addEventListener('click', () => go('lessonOpen', s.current - 1));
  const check = el('button', 'btn ghost check ' + st, isDone ? '✓ Comprobada' : 'Comprobar');
  check.disabled = busy;
  check.addEventListener('click', () => { showLessonError(''); go('lessonCheck'); });
  const hint = el('button', 'btn ghost', 'Pista (' + Math.min(L.hints.length, 3) + '/3)');
  hint.disabled = busy;
  hint.addEventListener('click', () => go('lessonHint'));
  const help = el('button', 'btn ghost', 'Ayuda');
  help.disabled = busy;
  help.addEventListener('click', () => { helpOpen = !helpOpen; renderLesson(s); });
  const complete = el('button', 'btn ghost', 'Completa');
  complete.title = 'Dar la lección por terminada y cerrarla';
  complete.disabled = busy || isDone;
  complete.addEventListener('click', () => go('lessonComplete'));
  const next = el('button', 'btn ghost', '→');
  next.title = 'Lección siguiente';
  next.disabled = busy || s.current >= s.unlocked;
  next.addEventListener('click', () => go('lessonOpen', s.current + 1));
  btns.append(prev, check, complete, hint, help);
  if (s.canSolution && !L.solutionShown) {
    const sol = el('button', 'btn ghost', 'Ver solución');
    sol.disabled = busy;
    sol.addEventListener('click', () => go('lessonSolution'));
    btns.append(sol);
  }
  if (L.solutionShown && !isDone) {
    const skip = el('button', 'btn ghost', 'Saltar');
    skip.disabled = busy;
    skip.addEventListener('click', () => go('lessonSkip'));
    btns.append(skip);
  }
  btns.append(next);
  view.append(btns);

  // Resultado de la comprobación.
  if (isDone) view.append(el('p', 'note ready', '¡Lección completada! ' + (L.last && L.last.summary ? L.last.summary : '')));
  else if (L.last && L.last.state !== 'ok') {
    const r = el('div', 'result-box ' + L.last.state);
    r.append(el('strong', '', L.last.state === 'fail' ? 'Hay errores' : 'No pude confirmarlo'));
    if (L.last.summary) r.append(el('p', '', L.last.summary));
    if (L.last.issues.length) {
      const ul = el('ul', 'issues');
      L.last.issues.forEach((i) => {
        const li = el('li');
        li.append(el('code', '', i.where), el('span', '', ' — ' + i.why));
        if (i.fix) li.append(el('span', 'muted fix', 'Cómo arreglarlo: ' + i.fix));
        ul.append(li);
      });
      r.append(ul);
    }
    if (L.last.tips && L.last.tips.length) {
      r.append(el('strong', 'tips-title', 'Errores frecuentes'));
      const tl = el('ul', 'tips');
      L.last.tips.forEach((t) => tl.append(el('li', '', t)));
      r.append(tl);
    }
    if (L.last.state === 'unsure') r.append(el('p', 'muted', 'Prueba la comprobación manual de arriba; si todo funciona, pídele ayuda al profesor.'));
    if (L.attempts && L.last.state === 'fail') r.append(el('p', 'muted', 'Intentos sin éxito: ' + L.attempts + (s.canSolution ? '' : ' (la solución se desbloquea a los 3)')));
    view.append(r);
  }

  if (s.milestone) {
    const ms = el('section', 'lsec milestone');
    ms.append(el('h3', '', 'Hito: ' + s.milestone), el('p', 'muted', 'Arranca tu proyecto y el original, y compara lo que responde cada uno. Se puede probar cuando ya están los archivos necesarios.'));
    const pb = el('button', 'btn ghost', L.probe ? 'Probar de nuevo' : 'Probar el proyecto');
    pb.disabled = busy;
    pb.addEventListener('click', () => go('lessonProbe'));
    ms.append(pb);
    if (L.probe) {
      const r = el('div', 'result-box ' + (L.probe.state === 'ok' ? 'ok' : L.probe.state));
      r.append(el('strong', '', L.probe.state === 'ok' ? '✓ Hito superado' : L.probe.state === 'fail' ? 'Hay diferencias' : 'Todavía no se puede probar'), el('p', '', L.probe.summary));
      if (L.probe.lines.length) {
        const ul = el('ul', 'issues');
        L.probe.lines.forEach((x) => { const li = el('li'); li.append(el('code', '', (x.ok ? '✓ ' : '✗ ') + x.url), el('span', '', ' — ' + x.detail)); ul.append(li); });
        r.append(ul);
      }
      ms.append(r);
    }
    // Repaso: ¿sigue en pie todo lo anterior?
    const rg = el('div', 'regress');
    const rb = el('button', 'btn ghost', s.regress ? 'Repasar de nuevo las lecciones anteriores' : 'Repasar lecciones anteriores');
    rb.disabled = busy;
    rb.addEventListener('click', () => go('lessonRegress'));
    rg.append(rb);
    if (s.regress) {
      const R = s.regress;
      const bad = R.broken.length;
      const box = el('div', 'result-box ' + (bad ? 'fail' : 'ok'));
      box.append(el('strong', '', bad ? bad + ' de ' + R.checked + ' lecciones dejaron de cumplirse' : '✓ Las ' + R.checked + ' lecciones repasadas siguen en pie'));
      if (bad) {
        const ul = el('ul', 'issues');
        R.broken.forEach((b) => {
          const li = el('li');
          const open = el('button', 'link-btn', 'Lección ' + (b.n + 1) + ': ' + b.title);
          open.addEventListener('click', () => go('lessonOpen', b.n));
          li.append(open, el('span', '', ' — ' + b.issues[0].why));
          if (b.issues[0].fix) li.append(el('span', 'muted fix', b.issues[0].fix));
          ul.append(li);
        });
        box.append(ul);
      }
      rg.append(box);
    }
    ms.append(rg);
    view.append(ms);
  }

  if (L.hints.length) {
    const h = el('section', 'lsec');
    h.append(el('h3', '', 'Pistas'));
    L.hints.forEach((x, i) => h.append(el('p', 'hint-item', (i + 1) + '. ' + x)));
    view.append(h);
  }

  if (L.solutionShown) {
    const sol = el('section', 'lsec');
    sol.append(el('h3', '', 'Solución del proyecto original'));
    C.blocks.forEach((b) => { sol.append(el('code', '', b.file)); const pre = el('pre'); pre.append(el('code', '', b.ref)); sol.append(pre); });
    sol.append(el('p', 'muted', 'Puedes nombrar variables y funciones distinto; lo importante es que haga lo mismo.'));
    view.append(sol);
  }

  if (helpOpen) {
    const hp = el('section', 'lsec help');
    hp.append(el('h3', '', 'Ayuda'));
    if (!L.chat.length) hp.append(el('p', 'muted', 'Pregunta lo que no entiendas de esta lección. El profesor ve tu código actual.'));
    L.chat.forEach((m) => hp.append(el('div', 'bubble ' + m.role, m.text)));
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Escribe tu duda…';
    ta.value = helpDraft;
    ta.addEventListener('input', () => { helpDraft = ta.value; });
    const send = el('button', 'btn', 'Preguntar');
    send.disabled = busy;
    const ask = () => { const q = ta.value.trim(); if (!q) return; helpDraft = ''; go('lessonHelp', q); };
    send.addEventListener('click', ask);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
    hp.append(ta, send);
    view.append(hp);
  }
  view.scrollTop = keepScroll;
}

vscode.postMessage({ type: 'refresh' });
