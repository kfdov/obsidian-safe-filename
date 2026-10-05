// Подменяем модуль obsidian имитацией его внутренностей (по app.js Obsidian 1.13.7)
const Module = require('module');
const mock = require('./obsidian-mock');
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'obsidian' ? mock : origLoad.call(this, req, ...rest); };
const ob = mock;
const { TFile, TFolder, Modal, MarkdownView, _HP: HP, _HD: HD, _zD: zD, _checkPath: checkPath, _warnings: warnings } = ob;
global.window = { setTimeout: () => 0, clearTimeout() {}, i18next: { t: (k) => (k === 'plugins.file-explorer.label-untitled-file' ? 'Без названия' : k) } };
global.document = {};
const assert = require('assert');
let pass = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); pass++; console.log('ok:', msg || JSON.stringify(b)); };

// ---- vault ----
const handlers = { rename: [], create: [], delete: [] };
const fms = {};
const contents = {};
const vault = {
  fileMap: {},
  on(n, f) { handlers[n].push(f); return {}; },
  getRoot() { return this.fileMap['/']; },
  getAbstractFileByPath(p) { return this.fileMap[p] || null; },
  checkForDuplicate(f, n) { const p = f.getNewPathAfterRename(n); const e = this.fileMap[p]; return !!e && e !== f; },
  async create(p) {
    checkPath(p);
    if (this.fileMap[p]) throw new Error('exists');
    const d = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '/';
    const par = this.fileMap[d];
    const f = new TFile(this, p, par); par.children.push(f); this.fileMap[p] = f; fms[p] = {};
    for (const h of handlers.create) h(f);
    await new Promise((r) => setImmediate(r));
    return f;
  },
  getMarkdownFiles() { return Object.values(this.fileMap).filter((f) => f instanceof TFile && f.extension === "md"); },
  async process(f, fn) { contents[f.path] = fn(contents[f.path] || ""); return contents[f.path]; },
  async rename(f, np) {
    checkPath(np);
    if (this.fileMap[np] && this.fileMap[np] !== f) throw new Error('Destination exists');
    const old = f.path; delete this.fileMap[old];
    if (f instanceof TFile) f._set(np); else { f.path = np; f.name = np.split('/').pop(); }
    this.fileMap[np] = f; fms[np] = fms[old] || {}; contents[np] = contents[old]; if (old !== np) { delete fms[old]; delete contents[old]; }
    for (const h of handlers.rename) h(f, old);
    await new Promise((r) => setImmediate(r));
  },
};
const root = new TFolder(vault, '/', null); root.path = '/'; vault.fileMap['/'] = root;
const notes = new TFolder(vault, 'notes', root); root.children.push(notes); vault.fileMap.notes = notes;
const fileManager = {
  renameFile: async (f, p) => vault.rename(f, p),
  processFrontMatter: async (f, fn) => { fms[f.path] = fms[f.path] || {}; fn(fms[f.path]); },
  async createNewMarkdownFileFromLinktext(lt, src) { if (HD.test(lt.split("/").pop())) throw new Error("ERR invalid"); return this.createNewFile(this.getNewFileParent(src), lt); },
  getNewFileParent() { return notes; },
  async createNewFile(parent, name) {
    const pre = parent ? (parent.path === "/" ? "" : parent.path + "/") : "";
    let p = pre + name + ".md"; for (let n = 1; vault.fileMap[p]; n++) p = pre + name + " " + n + ".md";
    return vault.create(p);
  },
};
// Встраивание (Bases): отдельный класс со своими saveTitle/onTitleChange
class J1 extends ob._YZ {}
J1.prototype.saveTitle = async function (el) {
  if (this.file !== this.fileBeingRenamed) return;
  const o = el.textContent.trim(); const e = HP(this.app, this.file, o, true);
  if (e) { warnings.push('j1 ' + e); return; }
  await this.app.fileManager.renameFile(this.file, this.file.getNewPathAfterRename(o));
};
J1.prototype.onTitleChange = function (el) { if (HP(this.app, this.file, el.textContent.trim(), false)) warnings.push('j1 live'); };
const embedRegistry = { getEmbedCreator() { return (ctx, file) => new J1(ctx.app, file); } };
// Проводник
class Explorer {
  constructor() { this.fileItems = {}; this.fileBeingRenamed = null; }
  async saveRename() {
    const e = this.fileBeingRenamed; const i = this.fileItems[e.path].innerEl.textContent.trim();
    const r = HP(app, e, i, true); if (r) { warnings.push('exp ' + r); return false; }
    if (zD.test(i)) { warnings.push('exp unsafe'); return false; }
    await app.fileManager.renameFile(e, e.getNewPathAfterRename(i)); return true;
  }
}
const explorer = new Explorer();
// Модальное окно переименования (vR): его validate упоминает msgInvalidCharacters
class RenameModal extends Modal {
  constructor(app, file) { super(app); this.file = file; }
  validate(t) { /* bd.plugins.fileExplorer.msgInvalidCharacters */ return HP(this.app, this.file, t, true) || (zD.test(t) ? 'unsafe' : ''); }
  async submit(t) { const v = this.validate(t); if (v) { warnings.push('modal ' + v); return; } await this.app.fileManager.renameFile(this.file, this.file.getNewPathAfterRename(t)); }
}
class OtherModal extends Modal { validate() { return ''; } submit(t) { this.got = t; } }

const linkRe = /\[\[([^\[\]|#]*)[^\]]*\]\]/g;
const metadataCache = {
  getFirstLinkpathDest(p) { return vault.getMarkdownFiles().find((f) => f.basename === p || f.path === p + ".md") || null; },
  getFileCache(f) { return { frontmatter: fms[f.path] }; },
  fileToLinktext(f) { return f.basename; },
  get unresolvedLinks() {
    const r = {};
    for (const [src, text] of Object.entries(contents)) { r[src] = {}; for (const m of (text || "").matchAll(linkRe)) if (!this.getFirstLinkpathDest(m[1].trim())) r[src][m[1].trim()] = 1; }
    return r;
  },
};
const app = { vault, fileManager, embedRegistry, metadataCache, workspace: { async openLinkText(lt, src) { return new ob.WorkspaceLeaf(app).openLinkText(lt, src); }, on() { return {}; }, onLayoutReady(f) { f(); }, iterateAllLeaves(cb) { cb({ view: explorer }); } } };
const el = (t) => ({ textContent: t, normalize() {}, childNodes: [{ nodeType: 3 }], get firstChild() { return this.childNodes[0]; } });
const P = require('../main.js');
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  const plugin = new P(app); await plugin.onload();
  const mk = (name) => vault.create('notes/' + name + '.md');
  const rename = async (v, text) => { v.fileBeingRenamed = v.file; await v.saveTitle(el(text)); await tick(); };

  // 1. Inline-заголовок: недопустимые символы + занятое имя
  await mk('Вопрос что');
  const a = await mk('Untitled');
  const view = new MarkdownView(app, a);
  view.onTitleChange(el('Вопрос: что?'));
  eq(warnings.length, 0, 'нет живого предупреждения в заголовке');
  await rename(view, 'Вопрос: что?');
  eq(a.path, 'notes/Вопрос что 1.md', 'вкладка: замена + номер');
  eq(fms[a.path].title, 'Вопрос: что?', 'вкладка: title');

  // 2. Переименование в чистое имя -> title, добавленный плагином, удаляется
  await rename(view, 'Ответ');
  eq(a.path, 'notes/Ответ.md');
  eq(fms[a.path].title, undefined, 'title удалён при смене имени');

  // 3. Пользователь сам поменял title -> не трогаем
  await rename(view, 'А/Б');
  eq(fms[a.path].title, 'А/Б');
  fms[a.path].title = 'Мой заголовок';
  await rename(view, 'В');
  eq(fms[a.path].title, 'Мой заголовок', 'отредактированный пользователем title сохранён');

  // 4. Aliases: добавляется и удаляется только своё
  plugin.settings.addAlias = true;
  fms[a.path].aliases = ['свой'];
  await rename(view, 'Г: д');
  eq(fms[a.path].aliases, ['свой', 'Г: д'], 'alias добавлен');
  await rename(view, 'Е');
  eq(fms[a.path].aliases, ['свой'], 'добавленный плагином alias удалён');
  plugin.settings.addAlias = false;

  // 5. Пустое имя
  await rename(view, '   ');
  eq(a.path, 'notes/Без названия.md', 'пустое имя -> «Без названия»');
  const b = await mk('Ж'); const vb = new MarkdownView(app, b);
  await rename(vb, '');
  eq(b.path, 'notes/Без названия 1.md', 'второе пустое -> «Без названия 1»');
  await rename(vb, '???');
  eq(b.path, 'notes/Без названия 1.md', '«???» у безымянного — без перенумерации');

  // 6. Bases: встроенная заметка в поповере
  const nb = await mk('Untitled');
  const embed = app.embedRegistry.getEmbedCreator(nb)({ app }, nb);
  embed.onTitleChange(el('a|b [x]'));
  await rename(embed, 'a|b [x]');
  eq(nb.path, 'notes/a b x.md', 'Bases: переименован');
  eq(fms[nb.path].title, 'a|b [x]', 'Bases: title');

  // 7. Проводник
  plugin.patchOpenViews();
  const c = await mk('файл');
  explorer.fileBeingRenamed = c; explorer.fileItems[c.path] = { innerEl: el('C# / заметки') };
  await explorer.saveRename(); await tick();
  eq(c.path, 'notes/C заметки.md', 'проводник: файл');
  const fld = new TFolder(vault, 'notes/sub', notes); notes.children.push(fld); vault.fileMap['notes/sub'] = fld;
  fld.getNewPathAfterRename = (n) => 'notes/' + n;
  explorer.fileBeingRenamed = fld; explorer.fileItems[fld.path] = { innerEl: el('Папка: 1') };
  await explorer.saveRename();
  eq(fld.path, 'notes/Папка 1', 'проводник: папка');

  // 8. Модальное окно переименования; чужие модалки не трогаем
  const d = await mk('модал');
  const m = new RenameModal(app, d); m.open();
  eq(m.validate('x:y'), '', 'модалка: validate пропускает');
  await m.submit('x:y'); await tick();
  eq(d.path, 'notes/x y.md', 'модалка: переименовано');
  const om = new OtherModal(app); om.open(); om.submit('a:b');
  eq(om.got, 'a:b', 'чужая модалка не изменена');

  // 9. Создание по ссылке и программное создание
  const e = await fileManager.createNewMarkdownFileFromLinktext('Что: это?', ''); await tick();
  eq(e.path, 'notes/Что это.md', 'создание по ссылке');
  eq(fms[e.path].title, 'Что: это?', 'создание по ссылке: title');
  const f = await vault.create('notes/x*y.md'); await tick();
  eq(f.path, 'notes/x y 1.md', 'vault.create: замена + номер');
  const g = await vault.create('notes/image #1.png');
  eq(g.path, 'notes/image #1.png', 'вложения с # не трогаются');

  // 10. Клик по битой ссылке [[name?]]
  const src = await mk('Источник');
  contents[src.path] = 'см. [[name?]] и [[name?#Раздел]], ещё [[name?|своё]] и ![[name?]]';
  const other = await mk('Другая');
  contents[other.path] = 'тоже [[name?]]';
  const leaf = new ob.WorkspaceLeaf(app);
  await app.workspace.openLinkText('name?', src.path, true); await tick();
  const created = vault.getMarkdownFiles().filter((f) => f.basename.startsWith('name'));
  eq(created.map((f) => f.path), ['notes/name.md'], 'клик: создан один файл');
  eq(fms['notes/name.md'].title, 'name?', 'клик: title = текст ссылки');
  eq(contents[src.path], 'см. [[name|name?]] и [[name#Раздел|name?]], ещё [[name|своё]] и ![[name]]', 'ссылки в исходной заметке переписаны');
  eq(contents[other.path], 'тоже [[name|name?]]', 'та же битая ссылка в другой заметке тоже исправлена');

  // повторный клик по старой ссылке (например, из ещё не обновлённой копии) — без дублей
  await leaf.openLinkText('name?', src.path); await tick();
  eq(leaf.opened.path, 'notes/name.md', 'повторный клик открывает ту же заметку');
  eq(vault.getMarkdownFiles().filter((f) => f.basename.startsWith('name')).length, 1, 'дублей нет');

  // двойной клик подряд — один файл
  await Promise.all([leaf.openLinkText('z: w', src.path), leaf.openLinkText('z: w', src.path)]); await tick();
  eq(vault.getMarkdownFiles().filter((f) => f.basename.startsWith('z w')).length, 1, 'двойной клик — один файл');

  // обычные ссылки не трогаем
  await leaf.openLinkText('Обычная', src.path); await tick();
  eq(leaf.opened.path, 'notes/Обычная.md', 'обычная ссылка — стандартное поведение');
  eq(fms['notes/Обычная.md'].title, undefined, 'обычной заметке title не пишется');

  // режим «не создавать»
  plugin.settings.brokenLinks = 'block';
  const before = vault.getMarkdownFiles().length;
  await app.workspace.openLinkText('Что?', src.path, true); await tick();
  eq(vault.getMarkdownFiles().length, before, 'block: файл не создан');
  eq(ob._notices.length, 1, 'block: показана подсказка');
  plugin.settings.brokenLinks = 'fix';

  // 11. Имя по умолчанию: если перевода нет, i18next возвращает ключ — его в имя не пускаем
  const realT = window.i18next.t;
  window.i18next.t = (k) => k;
  eq(plugin.emptyBase(), 'Untitled', 'нет перевода → Untitled, а не ключ');
  window.i18next.t = realT;
  eq(plugin.emptyBase(), 'Без названия', 'перевод по настоящему ключу');

  // 12. Режим «дата/время» вместо номера
  plugin.settings.duplicateMode = 'date';
  const dd = await mk('дата');
  const vd = new MarkdownView(app, dd);
  await rename(vd, 'Вопрос: что?');
  eq(dd.path, 'notes/Вопрос что 1005143012.md', 'дата: суффикс по формату MMDDHHmmss');
  eq(fms[dd.path].title, 'Вопрос: что?', 'дата: title');
  const dd2 = await mk('дата2');
  await rename(new MarkdownView(app, dd2), 'Вопрос что');
  eq(dd2.path, 'notes/Вопрос что 1005143012 1.md', 'дата: в ту же секунду — ещё и номер');
  plugin.settings.duplicateDateFormat = 'HH:mm';
  const dd3 = await mk('дата3');
  await rename(new MarkdownView(app, dd3), 'Вопрос что');
  eq(dd3.path, 'notes/Вопрос что 14 30.md', 'дата: двоеточие из формата тоже заменяется');
  plugin.settings.duplicateDateFormat = 'MMDDHHmmss';
  eq(plugin.matchesNumbered('Без названия 1005143012', 'Без названия'), true, 'дата: распознаёт свой суффикс');
  eq(plugin.matchesNumbered('Без названия 3', 'Без названия'), true, 'дата: номер тоже распознаёт');
  eq(plugin.matchesNumbered('Без названия смысла', 'Без названия'), false, 'дата: обычные слова не путает с датой');
  plugin.settings.duplicateMode = 'number';

  // 13. Заметка открыта в редакторе: свойства пишутся через редактор, курсор уходит под них
  // Курсор как в CodeMirror: вставка ровно в позицию курсора оставляет его перед вставкой.
  const mkEditor = (text, cur) => ({
    text, cur,
    getValue() { return this.text; },
    getCursor() { return { o: this.cur }; },
    setCursor(p) { this.cur = p.o; },
    posToOffset(p) { return p.o; },
    offsetToPos(o) { return { o }; },
    replaceRange(s, a, b) {
      this.text = this.text.slice(0, a.o) + s + this.text.slice(b.o);
      if (this.cur >= b.o && this.cur > a.o) this.cur += s.length - (b.o - a.o);
      else if (this.cur > a.o) this.cur = a.o;
    },
    enter() { this.replaceRange('\n', { o: this.cur }, { o: this.cur }); this.cur += 1; },
  });
  const en = await mk('Untitled');
  const ev = new MarkdownView(app, en);
  ev.getMode = () => 'source';
  ev.editor = mkEditor('', 0); // новая пустая заметка, курсор в начале — как после Enter в заголовке
  await rename(ev, 'Энтер: тест');
  eq(ev.editor.text, '---\ntitle: Энтер: тест\n---\n', 'редактор: свойства записаны через редактор');
  eq(ev.editor.cur, ev.editor.text.length, 'редактор: курсор под свойствами, а не перед ---');
  ev.editor.enter();
  eq(ev.editor.text.startsWith('---\n'), true, 'второй Enter не ломает свойства');

  // Уже есть текст и курсор в нём — курсор сдвигается вместе с текстом
  const en2 = await mk('С текстом');
  const ev2 = new MarkdownView(app, en2);
  ev2.getMode = () => 'source';
  ev2.editor = mkEditor('---\nтег: x\n---\nПривет', 17);
  await rename(ev2, 'Q?');
  eq(ev2.editor.text, '---\nтег: x\ntitle: Q?\n---\nПривет', 'редактор: существующие свойства сохранены');
  eq(ev2.editor.text.slice(ev2.editor.cur), 'ивет', 'редактор: курсор остался на том же месте в тексте');
  // Переименование в чистое имя — свой title убирается тоже через редактор
  await rename(ev2, 'Чистое');
  eq(ev2.editor.text, '---\nтег: x\n---\nПривет', 'редактор: title удалён, остальное на месте');

  eq(warnings, [], 'ни одного предупреждения Obsidian за прогон');
  plugin.onunload();
  eq(MarkdownView.prototype.saveTitle === ob._YZ.prototype.saveTitle && !Object.prototype.hasOwnProperty.call(vault, 'nonexistent'), true, 'патчи сняты');
  console.log(`\n${pass} проверок пройдено`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
