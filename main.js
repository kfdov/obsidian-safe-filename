'use strict';

const {
  Plugin, PluginSettingTab, Setting, Modal, MarkdownView, WorkspaceLeaf, Notice,
  TAbstractFile, TFile, TFolder, normalizePath, parseLinktext, parseYaml, stringifyYaml, moment,
} = require('obsidian');

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  // \ / : * ? " < > |  — запрещены ОС;  # ^ [ ]  — ломают ссылки в Obsidian
  forbidden: '\\/:*?"<>|#^[]',
  replaceMode: 'char', // 'char' | 'lookalike'
  replacement: ' ',
  numberSeparator: ' ',
  // Что добавлять к имени, если такой файл уже есть: 'number' — «Заметка 1», 'date' — «Заметка 1005143012»
  duplicateMode: 'number',
  duplicateDateFormat: 'MMDDHHmmss', // формат moment.js: месяц, день, часы, минуты, секунды
  titleKey: 'title',
  titleMode: 'changed', // 'changed' | 'always'
  addAlias: false,
  // Держать первый заголовок «# …» равным введённому имени
  syncHeading: false,
  interceptCreate: true,
  allowEmpty: true,
  // Имя для пустого ввода и для новых файлов вместо «Без названия» (Untitled).
  // Пусто — {{date}}, т.е. «2026-10-05 14-30-12». Поддерживает {{date:ФОРМАТ}}.
  emptyName: '',
  suppressWarnings: true,
  // Ссылка вида [[name?]] на несуществующую заметку:
  // 'fix'   — открыть/создать заметку с исправленным именем и переписать ссылку в [[name|name?]]
  // 'block' — ничего не создавать, показать подсказку
  brokenLinks: 'fix',
  maxBytes: 240,
};

// Что Obsidian отвергает на уровне файловой системы (используется для программных вызовов
// не-заметок, чтобы не переименовывать вложения и папки других плагинов без необходимости).
const OS_FORBIDDEN = '\\/:*?"<>|';
const NOTE_EXTS = new Set(['md', 'canvas', 'base']);

const LOOKALIKES = {
  '\\': '⧵', '/': '∕', ':': '꞉', '*': '∗', '?': '？', '"': '＂',
  '<': '‹', '>': '›', '|': 'ǀ', '#': '＃', '^': 'ˆ', '[': '［', ']': '］',
};

const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

// ---------------------------------------------------------------------------
// Чистые функции
// ---------------------------------------------------------------------------

function truncateBytes(s, maxBytes) {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let out = '';
  let size = 0;
  for (const ch of s) {
    const len = enc.encode(ch).length;
    if (size + len > maxBytes) break;
    out += ch;
    size += len;
  }
  return out;
}

/** Делает из строки допустимое имя (без расширения). Может вернуть пустую строку. */
function sanitizeName(name, settings, opts = {}) {
  const forbidden = new Set(Array.from(opts.forbidden != null ? opts.forbidden : settings.forbidden));
  forbidden.add('/');
  forbidden.add('\\');

  let s = String(name).replace(/[\u0000-\u001f\u007f]/g, ' ');
  s = Array.from(s)
    .map((ch) => {
      if (!forbidden.has(ch)) return ch;
      if (settings.replaceMode === 'lookalike' && LOOKALIKES[ch]) return LOOKALIKES[ch];
      return settings.replacement;
    })
    .join('');

  s = s.replace(/\s+/g, ' ').trim();
  if (!opts.keepLeadingDot) s = s.replace(/^\.+/, '');
  s = truncateBytes(s, opts.maxBytes || settings.maxBytes);
  s = s.replace(/[. ]+$/, '');
  if (RESERVED_WIN.test(s)) s += '_';
  return s;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_EMPTY_NAME = '{{date}}';
const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD HH-mm-ss';
const DATE_TOKEN_RE = /\{\{date(?::([^}]+))?\}\}/g;

/**
 * Регулярка, узнающая отметку времени по формату moment.js:
 * группы букв → цифры (YYYY, MM, HH…) или буквы, если там названия (MMM, ddd, Do, a);
 * прочее — необязательный разделитель (после очистки имени он мог замениться или исчезнуть).
 */
function formatToRegex(fmt) {
  return fmt
    .replace(/\[[^\]]*\]/g, 'x')
    .replace(/[A-Za-z]+|[^A-Za-z]/g, (m) => {
      if (!/[A-Za-z]/.test(m)) return '[^\\p{L}\\d]?';
      return /MMM|ddd|Do|[aAx]/.test(m) ? '[\\p{L}\\d]+' : '\\d+';
    });
}

/** Регулярка, узнающая имя, сгенерированное по шаблону вида «Заметка {{date:…}}». */
function templateToRegex(tpl) {
  const literal = (s) => Array.from(s).map((ch) => (/[\p{L}\d]/u.test(ch) ? escapeRegExp(ch) : '[^\\p{L}\\d]?')).join('');
  let out = '';
  let last = 0;
  for (const m of tpl.matchAll(DATE_TOKEN_RE)) {
    out += literal(tpl.slice(last, m.index)) + formatToRegex(m[1] || DEFAULT_DATE_FORMAT);
    last = m.index + m[0].length;
  }
  return out + literal(tpl.slice(last));
}

function joinPath(dir, name) {
  return !dir || dir === '/' ? name : `${dir}/${name}`;
}

function withExt(base, ext) {
  return ext ? `${base}.${ext}` : base;
}

function splitPath(path) {
  const slash = path.lastIndexOf('/');
  return { dir: slash >= 0 ? path.slice(0, slash) : '', last: slash >= 0 ? path.slice(slash + 1) : path };
}

function splitExt(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot + 1) } : { base: name, ext: '' };
}

function basenameOfPath(path) {
  return splitExt(splitPath(path).last).base;
}

/** Переписывает вики-ссылки на oldPath в ссылки на newPath, сохраняя видимый текст. */
function replaceWikilinks(text, oldPath, newPath, display) {
  return text.replace(/(!?)\[\[([^\[\]|#\n]*?)(#[^\[\]|\n]*)?(\|[^\[\]\n]*)?\]\]/g, (m, bang, target, sub, alias) => {
    if (target.trim() !== oldPath) return m;
    // У встраивания |… означает размер/подпись — туда исходный текст не добавляем
    const shown = alias || (bang ? '' : `|${display}`);
    return `${bang}[[${newPath}${sub || ''}${shown}]]`;
  });
}

/**
 * Правка первого заголовка «# …» — первой непустой строки текста под свойствами.
 * text — что должно быть в заголовке (null — убрать, но только если там prev, т.е. наш).
 * Возвращает { from, to, insert, inserted } или null, если менять нечего.
 */
function headingEdit(doc, text, prev) {
  const fm = FRONTMATTER_RE.exec(doc);
  const bodyStart = fm ? fm[0].length : 0;
  const m = /^((?:[ \t]*\r?\n)*)#[ \t]+([^\r\n]*?)[ \t]*(\r?\n|$)/.exec(doc.slice(bodyStart));
  if (m) {
    const from = bodyStart + m[1].length;
    const lineEnd = bodyStart + m[0].length - m[3].length;
    if (text == null) return m[2] === prev ? { from, to: bodyStart + m[0].length, insert: '' } : null;
    const line = `# ${text}`;
    return doc.slice(from, lineEnd) === line ? null : { from, to: lineEnd, insert: line };
  }
  if (text == null) return null;
  return { from: bodyStart, to: bodyStart, insert: `# ${text}\n`, inserted: true };
}

function toArray(v) {
  if (Array.isArray(v)) return v.slice();
  return v == null || v === '' ? [] : [v];
}

/** То же, что делает Obsidian в onTitleChange до проверки: схлопывает разметку в чистый текст. */
function normalizeEditable(el) {
  el.normalize();
  const plain = el.childNodes.length === 1 && el.firstChild.nodeType === 3;
  if (plain || el.childNodes.length === 0) return;
  el.textContent = el.textContent;
  const doc = el.ownerDocument;
  if (doc.activeElement === el) {
    const sel = doc.defaultView.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ---------------------------------------------------------------------------
// Плагин
// ---------------------------------------------------------------------------

class SafeFilenamePlugin extends Plugin {
  async onload() {
    const raw = (await this.loadData()) || {};
    // Миграция с 1.0 (настройки лежали в корне файла)
    const savedSettings = raw.settings || raw;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    delete this.settings.settings;
    delete this.settings.managed;
    // path -> { key, title, alias? } — что именно плагин записал в свойства заметки
    this.managed = raw.managed || {};
    this.normalizeSettings();

    this.pendingByPath = new Map(); // итоговый путь (lower) -> введённое имя
    this.pendingByName = new Map(); // очищенное имя (lower) -> введённое имя (когда путь заранее неизвестен)
    this.unpatchers = [];
    this.patchedProtos = new WeakMap();
    this.saveTimer = null;
    this.titleOwners = new WeakMap(); // TFile -> вкладка/встраивание, где переименовывали
    this.linkJobs = new Map(); // путь из ссылки -> Promise<TFile>, чтобы двойной клик не создал два файла

    this.addSettingTab(new SafeFilenameSettingTab(this.app, this));
    this.installPatches();

    this.attachDomHooks(document);
    this.registerEvent(this.app.workspace.on('window-open', (win) => this.attachDomHooks(win.doc)));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.patchOpenViews()));
    this.app.workspace.onLayoutReady(() => this.patchOpenViews());

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onVaultRename(file, oldPath)));
    this.registerEvent(this.app.vault.on('create', (file) => this.onVaultCreate(file)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onVaultDelete(file)));
  }

  onunload() {
    for (const unpatch of this.unpatchers.reverse()) unpatch();
    this.unpatchers = [];
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.persist();
    }
  }

  normalizeSettings() {
    const s = this.settings;
    const strip = (v) => Array.from(v || '').filter((ch) => !s.forbidden.includes(ch) && ch !== '/' && ch !== '\\').join('');
    s.replacement = strip(s.replacement);
    s.numberSeparator = strip(s.numberSeparator);
    s.titleKey = (s.titleKey || '').trim() || 'title';
  }

  persist() {
    this.saveTimer = null;
    return this.saveData({ settings: this.settings, managed: this.managed });
  }

  scheduleSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persist(), 1000);
  }

  async saveSettings() {
    this.normalizeSettings();
    await this.persist();
  }

  // ---- Патчи ---------------------------------------------------------------

  /** Обёртка метода; factory получает оригинал и возвращает функцию, работающую с this. */
  patchMethod(obj, name, factory) {
    if (!obj || typeof obj[name] !== 'function') return false;
    const hadOwn = Object.prototype.hasOwnProperty.call(obj, name);
    const orig = obj[name];
    const patched = factory(orig);
    let active = true;
    const wrapper = function (...args) {
      return active ? patched.apply(this, args) : orig.apply(this, args);
    };
    obj[name] = wrapper;
    this.unpatchers.push(() => {
      active = false;
      if (obj[name] === wrapper) {
        if (hadOwn) obj[name] = orig;
        else delete obj[name];
      }
    });
    return true;
  }

  /** Патчит метод на том прототипе цепочки, где он реально объявлен (один раз). */
  patchProtoMethod(start, name, factory) {
    for (let p = start; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      if (!Object.prototype.hasOwnProperty.call(p, name)) continue;
      let done = this.patchedProtos.get(p);
      if (!done) this.patchedProtos.set(p, (done = new Set()));
      if (done.has(name)) return;
      done.add(name);
      this.patchMethod(p, name, factory);
      this.unpatchers.push(() => done.delete(name));
      return;
    }
  }

  installPatches() {
    const plugin = this;
    const { vault, fileManager } = this.app;

    // Редактируемые заголовки: вкладка, inline-заголовок заметки, встроенная заметка (Bases и т.п.)
    if (MarkdownView) this.patchTitleOwner(MarkdownView.prototype);
    const registry = this.app.embedRegistry;
    if (registry) {
      this.patchMethod(registry, 'getEmbedCreator', (orig) => function (...args) {
        const creator = orig.apply(this, args);
        if (typeof creator !== 'function') return creator;
        return function (...cargs) {
          const embed = creator.apply(this, cargs);
          try { plugin.patchTitleOwner(embed); } catch (e) { console.error('[safe-filename]', e); }
          return embed;
        };
      });
    }

    // Модальные окна «Переименовать файл» / «Новый файл»
    if (Modal) {
      this.patchMethod(Modal.prototype, 'open', (orig) => function (...args) {
        try { plugin.patchPromptModal(this); } catch (e) { console.error('[safe-filename]', e); }
        return orig.apply(this, args);
      });
    }

    // Переход по ссылке на несуществующую заметку (клик, Ctrl+клик, «Открыть в новой вкладке»…)
    const openLink = (orig) => async function (...args) {
      try {
        const r = await plugin.resolveBrokenLink(args[0], args[1]);
        if (r && r.blocked) return;
        if (r && r.file) args[0] = plugin.app.metadataCache.fileToLinktext(r.file, args[1] || '', true) + r.subpath;
      } catch (e) {
        console.error('[safe-filename]', e);
      }
      return orig.apply(this, args);
    };
    // Уровень workspace проверяем раньше листа, чтобы при запрете не открывалась пустая вкладка
    this.patchMethod(this.app.workspace, 'openLinkText', openLink);
    if (WorkspaceLeaf) this.patchMethod(WorkspaceLeaf.prototype, 'openLinkText', openLink);

    // Создание заметки из текста ссылки (другие места интерфейса)
    this.patchMethod(fileManager, 'createNewMarkdownFileFromLinktext', (orig) => async function (linktext, sourcePath, ...rest) {
      const r = await plugin.resolveBrokenLink(linktext, sourcePath);
      if (r && r.blocked) throw new Error(plugin.blockedMessage(r.name));
      if (r && r.file) return r.file;
      return orig.call(this, linktext, sourcePath, ...rest);
    });

    // Программный уровень: всё, что дошло до хранилища
    this.patchMethod(fileManager, 'renameFile', (orig) => function (file, newPath, ...rest) {
      return orig.call(this, file, plugin.fixTargetPath(file, newPath), ...rest);
    });
    this.patchMethod(vault, 'rename', (orig) => function (file, newPath, ...rest) {
      return orig.call(this, file, plugin.fixTargetPath(file, newPath), ...rest);
    });
    for (const name of ['create', 'createBinary']) {
      this.patchMethod(vault, name, (orig) => function (path, ...rest) {
        return orig.call(this, plugin.fixCreatePath(path, false), ...rest);
      });
    }
    this.patchMethod(vault, 'createFolder', (orig) => function (path, ...rest) {
      return orig.call(this, plugin.fixCreatePath(path, true), ...rest);
    });
    this.patchMethod(vault, 'copy', (orig) => function (file, newPath, ...rest) {
      return orig.call(this, file, plugin.fixCreatePath(newPath, file instanceof TFolder), ...rest);
    });

    this.patchOpenViews();
  }

  patchTitleOwner(objOrProto) {
    if (!objOrProto) return;
    const plugin = this;
    const start = Object.prototype.hasOwnProperty.call(objOrProto, 'constructor') ? objOrProto : Object.getPrototypeOf(objOrProto);

    this.patchProtoMethod(start, 'saveTitle', (orig) => function (el, ...rest) {
      try {
        const file = this.file;
        const renaming = !('fileBeingRenamed' in this) || this.fileBeingRenamed === file;
        if (el && file && !this.subpath && renaming) {
          plugin.titleOwners.set(file, this); // чей редактор открыт с этой заметкой (вкладка или встраивание)
          const finalBase = plugin.prepareUiRename(file, el.textContent);
          if (finalBase != null) el.textContent = finalBase;
        }
      } catch (e) {
        console.error('[safe-filename]', e);
      }
      return orig.call(this, el, ...rest);
    });

    this.patchProtoMethod(start, 'onTitleChange', (orig) => function (el, ...rest) {
      if (!plugin.settings.suppressWarnings) return orig.call(this, el, ...rest);
      normalizeEditable(el);
    });
  }

  patchOpenViews() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!view) return;
      if (typeof view.saveTitle === 'function') this.patchTitleOwner(view);
      if (typeof view.saveRename === 'function' && view.fileItems) this.patchExplorer(view);
    });
  }

  patchExplorer(view) {
    const plugin = this;
    this.patchProtoMethod(Object.getPrototypeOf(view), 'saveRename', (orig) => function (...args) {
      try {
        const file = this.fileBeingRenamed;
        const item = file && this.fileItems && this.fileItems[file.path];
        const el = item && item.innerEl;
        if (el) {
          const finalBase = plugin.prepareUiRename(file, el.textContent);
          if (finalBase != null) el.textContent = finalBase;
        }
      } catch (e) {
        console.error('[safe-filename]', e);
      }
      return orig.apply(this, args);
    });
  }

  patchPromptModal(modal) {
    if (modal.__safeFilename) return;
    if (typeof modal.validate !== 'function' || typeof modal.submit !== 'function') return;
    // Только окна, которые проверяют имя файла (узнаём по их собственной проверке)
    if (!/msgInvalidCharacters|msgUnsafeCharacters|msgBadDotfile/.test(String(modal.validate))) return;
    modal.__safeFilename = true;

    const plugin = this;
    const file = modal.file instanceof TAbstractFile ? modal.file : null;
    const origValidate = modal.validate;
    const origSubmit = modal.submit;
    modal.validate = function (value, ...rest) {
      return origValidate.call(this, plugin.previewPromptValue(file, value), ...rest);
    };
    modal.submit = function (value, ...rest) {
      return origSubmit.call(this, plugin.commitPromptValue(file, value), ...rest);
    };
  }

  attachDomHooks(doc) {
    // Проводник привязывает обработчик ввода через bind() при создании, поэтому живые
    // предупреждения о символах гасим здесь: capture-фаза срабатывает раньше него.
    this.registerDomEvent(doc, 'input', (evt) => {
      if (!this.settings.suppressWarnings) return;
      const t = evt.target;
      if (!t || t.nodeType !== 1 || !t.isContentEditable) return;
      if (!t.matches('.nav-file-title-content, .nav-folder-title-content')) return;
      evt.stopPropagation();
      normalizeEditable(t);
    }, true);
    this.registerDomEvent(doc, 'focusin', (evt) => {
      const t = evt.target;
      if (t && t.nodeType === 1 && t.isContentEditable) this.patchOpenViews();
    }, true);
  }

  // ---- Имена ---------------------------------------------------------------

  sanitize(name, opts) {
    return sanitizeName(name, this.settings, opts);
  }

  emptyTemplate() {
    return (this.settings.emptyName || '').trim() || DEFAULT_EMPTY_NAME;
  }

  /** Имя по шаблону — для пустого ввода и для новых файлов вместо «Без названия». */
  emptyBase() {
    const name = this.emptyTemplate().replace(DATE_TOKEN_RE, (_, fmt) => moment().format(fmt || DEFAULT_DATE_FORMAT));
    return this.sanitize(name) || this.sanitize(moment().format(DEFAULT_DATE_FORMAT));
  }

  /** Имя уже сгенерировано по шаблону (возможно, с номером/датой от совпадения). */
  isAutoName(name) {
    return new RegExp(`^${templateToRegex(this.emptyTemplate())}(${this.dupSuffixRegex()})?$`, 'iu').test(name);
  }

  /** «Untitled» / «Без названия» (с номером или без) — имя, которое Obsidian даёт сам. */
  isObsidianDefaultName(base) {
    const labels = new Set(['Untitled']);
    // Ключи i18next у Obsidian в kebab-case; если перевода нет, t() возвращает сам ключ
    const key = 'plugins.file-explorer.label-untitled-file';
    try {
      const t = window.i18next.t(key);
      if (t && t !== key) labels.add(t);
    } catch (e) { /* нет i18next — только английское */ }
    const alt = Array.from(labels).map(escapeRegExp).join('|');
    return new RegExp(`^(?:${alt})(?: \\d+)?$`).test(base);
  }

  /** Суффикс-отметка времени для режима «дата/время» (уже очищенный). */
  dateSuffix() {
    const fmt = (this.settings.duplicateDateFormat || '').trim() || DEFAULT_SETTINGS.duplicateDateFormat;
    return this.sanitize(moment().format(fmt), { keepLeadingDot: true });
  }

  /** Суффикс, который добавляется при совпадении имён: номер или (в режиме даты) отметка времени. */
  dupSuffixRegex() {
    const sep = escapeRegExp(this.settings.numberSeparator);
    if (this.settings.duplicateMode !== 'date') return `${sep}\\d+`;
    const fmt = (this.settings.duplicateDateFormat || '').trim() || DEFAULT_SETTINGS.duplicateDateFormat;
    return `${sep}(?:\\d+|${formatToRegex(fmt)}(?:${sep}\\d+)?)`;
  }

  /** base, base + номер, или (в режиме даты) base + отметка времени по формату. */
  matchesNumbered(name, base) {
    return new RegExp(`^${escapeRegExp(base)}(${this.dupSuffixRegex()})?$`, 'iu').test(name);
  }

  /**
   * Ближайшее свободное имя в папке (без учёта регистра):
   * режим «номер» — base, "base 1", "base 2"…; режим «дата» — "base 1005143012" (при совпадении + номер).
   */
  uniqueBase(dir, base, ext, self) {
    const folder = !dir || dir === '/' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(dir);
    const taken = new Set();
    if (folder instanceof TFolder) {
      for (const child of folder.children) {
        if (child !== self) taken.add(child.name.toLowerCase());
      }
    }
    const free = (b) => !taken.has(withExt(b, ext).toLowerCase());
    if (free(base)) return base;
    const sep = this.settings.numberSeparator;
    if (this.settings.duplicateMode === 'date') {
      const stamp = this.dateSuffix();
      if (stamp) {
        base = `${base}${sep}${stamp}`;
        if (free(base)) return base;
      }
    }
    for (let n = 1; ; n++) {
      const candidate = `${base}${sep}${n}`;
      if (free(candidate)) return candidate;
    }
  }

  /**
   * Что получится, если пользователь ввёл raw как новое имя file.
   * null — ничего не менять (то же имя или пустой ввод при запрете пустых имён).
   */
  computeUiName(file, raw) {
    const isFile = file instanceof TFile;
    const current = isFile ? file.basename : file.name;
    const typed = String(raw == null ? '' : raw).replace(/[\r\n]+/g, ' ').trim();
    if (typed === current) return null;
    if (!typed && !this.settings.allowEmpty) return null;

    const ext = isFile ? file.extension : '';
    const dir = file.parent ? file.parent.path : '';
    let base = typed ? this.sanitize(typed) : '';
    if (!base) {
      // Имя уже сгенерировано по шаблону — не генерируем заново
      if (this.isAutoName(current)) return { finalBase: current, original: typed || null, current };
      base = this.emptyBase();
    }
    return { finalBase: this.uniqueBase(dir, base, ext, file), original: typed || null, current };
  }

  /** computeUiName + запоминание введённого имени для записи в title. */
  prepareUiRename(file, raw) {
    const r = this.computeUiName(file, raw);
    if (!r) return null;
    if (file instanceof TFile && r.original) {
      const needTitle = r.finalBase !== r.original || this.settings.titleMode === 'always';
      if (r.finalBase === r.current) {
        // Файл не переименуется (имя уже такое), но введённый вариант другой — обновим title сразу.
        if (needTitle) this.applyTitle(file, r.original).then(() => this.syncHeading(file, r.original));
        else this.syncHeading(file, r.original);
      } else if (needTitle) {
        const dir = file.parent ? file.parent.path : '';
        this.rememberPath(joinPath(dir, withExt(r.finalBase, file.extension)), r.original);
      }
    }
    return r.finalBase;
  }

  previewPromptValue(file, value) {
    if (file) {
      const r = this.computeUiName(file, value);
      return r ? r.finalBase : value;
    }
    const typed = String(value == null ? '' : value).trim();
    return this.sanitize(typed) || (typed ? this.emptyBase() : typed);
  }

  commitPromptValue(file, value) {
    if (file) {
      const finalBase = this.prepareUiRename(file, value);
      return finalBase != null ? finalBase : value;
    }
    const typed = String(value == null ? '' : value).trim();
    const clean = this.sanitize(typed) || (typed ? this.emptyBase() : typed);
    if (typed && clean !== typed) this.rememberName(clean, typed);
    return clean;
  }

  rememberPath(path, typedName) {
    const key = path.toLowerCase();
    // Первым запоминает самый ранний слой — у него исходный текст; нижние слои видят уже очищенный.
    if (this.pendingByPath.has(key)) return;
    this.pendingByPath.set(key, typedName);
    window.setTimeout(() => this.pendingByPath.delete(key), 15000);
  }

  rememberName(cleanName, typedName) {
    const key = cleanName.toLowerCase();
    this.pendingByName.set(key, typedName);
    window.setTimeout(() => this.pendingByName.delete(key), 15000);
  }

  takePending(file) {
    const key = file.path.toLowerCase();
    if (this.pendingByPath.has(key)) {
      const v = this.pendingByPath.get(key);
      this.pendingByPath.delete(key);
      return v;
    }
    for (const [name, typed] of this.pendingByName) {
      if (this.matchesNumbered(file.basename, name)) {
        this.pendingByName.delete(name);
        return typed;
      }
    }
    return undefined;
  }

  fixTargetPath(file, newPath) {
    if (!(file instanceof TAbstractFile) || typeof newPath !== 'string') return newPath;
    const path = normalizePath(newPath);
    if (path === file.path) return newPath;

    const { dir, last } = splitPath(path);
    const isFile = file instanceof TFile;
    const { base, ext } = isFile ? splitExt(last) : { base: last, ext: '' };
    const currentBase = isFile ? file.basename : file.name;
    if (base === currentBase) {
      // Чистое перемещение — имя не трогаем, только избегаем конфликта.
      const finalBase = this.uniqueBase(dir, base, ext, file);
      if (finalBase !== base && isFile) this.rememberPath(joinPath(dir, withExt(finalBase, ext)), base);
      return joinPath(dir, withExt(finalBase, ext));
    }

    const note = isFile && NOTE_EXTS.has(ext.toLowerCase());
    const clean = this.sanitize(base, { keepLeadingDot: true, forbidden: note ? undefined : OS_FORBIDDEN }) || this.emptyBase();
    const finalBase = this.uniqueBase(dir, clean, ext, file);
    if (isFile && (finalBase !== base || this.settings.titleMode === 'always')) {
      this.rememberPath(joinPath(dir, withExt(finalBase, ext)), base);
    }
    return joinPath(dir, withExt(finalBase, ext));
  }

  fixCreatePath(path, isFolder) {
    if (typeof path !== 'string') return path;
    const { dir, last } = splitPath(normalizePath(path));
    const { base, ext } = isFolder ? { base: last, ext: '' } : splitExt(last);
    const note = !isFolder && NOTE_EXTS.has(ext.toLowerCase());

    // Все пути создания (Ctrl+N, проводник, Bases, холст, CLI) сходятся в vault.create —
    // здесь стандартное «Без названия N» меняется на имя по шаблону плагина.
    if (note && this.isObsidianDefaultName(base)) {
      return joinPath(dir, withExt(this.uniqueBase(dir, this.emptyBase(), ext, null), ext));
    }

    if (!this.settings.interceptCreate) return path;
    const clean = this.sanitize(base, { keepLeadingDot: true, forbidden: note ? undefined : OS_FORBIDDEN });
    if (clean === base) return path;

    const finalBase = this.uniqueBase(dir, clean || this.emptyBase(), ext, null);
    const finalPath = joinPath(dir, withExt(finalBase, ext));
    if (!isFolder) this.rememberPath(finalPath, base);
    return finalPath;
  }

  // ---- Ссылки на несуществующие заметки -----------------------------------

  blockedMessage(name) {
    return `Имя «${name}» содержит недопустимые символы — заметка не создана. Создайте её через Ctrl+N и введите имя в заголовке.`;
  }

  /**
   * Если linktext указывает на несуществующую заметку с недопустимым именем —
   * находит или создаёт подходящую и переписывает ссылки. null — ссылка обычная, не вмешиваемся.
   */
  async resolveBrokenLink(linktext, sourcePath) {
    if (typeof linktext !== 'string') return null;
    const { path, subpath } = parseLinktext(linktext);
    if (!path) return null;
    if (this.app.metadataCache.getFirstLinkpathDest(path, sourcePath || '')) return null;

    const segs = path.split('/');
    const name = segs.pop().trim();
    const dirs = segs.map((p) => this.sanitize(p, { keepLeadingDot: true }) || p);
    const clean = this.sanitize(name) || this.emptyBase();
    if (clean === name && dirs.join('/') === segs.join('/')) return null;

    if (this.settings.brokenLinks === 'block') {
      new Notice(this.blockedMessage(name));
      return { blocked: true, name };
    }

    const key = path.toLowerCase();
    if (!this.linkJobs.has(key)) {
      const job = this.createForLink(path, name, clean, dirs, sourcePath || '');
      this.linkJobs.set(key, job);
      job.then(() => this.linkJobs.delete(key), () => this.linkJobs.delete(key));
    }
    const file = await this.linkJobs.get(key);
    return { file, subpath: subpath || '' };
  }

  async createForLink(path, name, clean, dirs, sourcePath) {
    let file = this.findNoteByTitle(name, clean);
    if (!file) {
      const target = dirs.concat(clean).join('/');
      const parent = dirs.length ? null : this.app.fileManager.getNewFileParent(sourcePath, clean);
      this.rememberName(clean, name);
      file = await this.app.fileManager.createNewFile(parent, target);
    }
    await this.rewriteLinks(path, file, name, sourcePath);
    return file;
  }

  /** Заметка, созданная раньше под этим именем (её title = введённое имя). */
  findNoteByTitle(original, clean) {
    const { vault, metadataCache } = this.app;
    let found = [];
    for (const [p, rec] of Object.entries(this.managed)) {
      const f = rec.title === original && vault.getAbstractFileByPath(p);
      if (f instanceof TFile) found.push(f);
    }
    if (!found.length) {
      found = vault.getMarkdownFiles().filter((f) => {
        const fm = (metadataCache.getFileCache(f) || {}).frontmatter;
        return fm && fm[this.settings.titleKey] === original && this.matchesNumbered(f.basename, clean);
      });
    }
    found.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    return found[0] || null;
  }

  /** Во всех заметках с этой битой ссылкой направляет её на file, оставляя видимым исходный текст. */
  async rewriteLinks(oldPath, file, display, sourcePath) {
    const { vault, metadataCache } = this.app;
    const sources = new Set(sourcePath ? [sourcePath] : []);
    for (const [src, links] of Object.entries(metadataCache.unresolvedLinks || {})) {
      if (links && Object.prototype.hasOwnProperty.call(links, oldPath)) sources.add(src);
    }
    for (const src of sources) {
      const sf = vault.getAbstractFileByPath(src);
      if (!(sf instanceof TFile) || sf.extension !== 'md') continue;
      const linkpath = metadataCache.fileToLinktext(file, src, true);
      try {
        await this.flushOpenViews(sf);
        await vault.process(sf, (text) => replaceWikilinks(text, oldPath, linkpath, display));
      } catch (e) {
        console.error('[safe-filename] не удалось обновить ссылки в', src, e);
      }
    }
  }

  /** Сохраняет несохранённые правки открытых редакторов, чтобы не перезаписать их. */
  async flushOpenViews(file) {
    const views = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view && leaf.view.file === file && typeof leaf.view.save === 'function') views.push(leaf.view);
    });
    for (const v of views) await v.save();
  }

  // ---- title / aliases -----------------------------------------------------

  async onVaultCreate(file) {
    if (!(file instanceof TFile)) return;
    // Только файлы, созданные нашими путями: чужие создания (синхронизация, плагины) не трогаем
    const original = this.takePending(file);
    if (original === undefined) return;
    await this.applyTitle(file, original);
    await this.syncHeading(file, original);
  }

  async onVaultRename(file, oldPath) {
    this.moveRecords(file, oldPath);
    if (!(file instanceof TFile)) return;
    const original = this.takePending(file);
    const nameChanged = basenameOfPath(oldPath) !== file.basename;
    const rec = this.managed[file.path];
    if (original !== undefined) {
      await this.applyTitle(file, original);
    } else if (rec && rec.title !== undefined && nameChanged) {
      // Имя сменилось, а наш title относился к старому имени — убираем то, что добавляли мы.
      await this.cleanupTitle(file);
    }
    if (original !== undefined || nameChanged) await this.syncHeading(file, original);
  }

  onVaultDelete(file) {
    let changed = false;
    for (const p of Object.keys(this.managed)) {
      if (p === file.path || p.startsWith(file.path + '/')) {
        delete this.managed[p];
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  moveRecords(file, oldPath) {
    let changed = false;
    for (const p of Object.keys(this.managed)) {
      let np = null;
      if (p === oldPath) np = file.path;
      else if (file instanceof TFolder && p.startsWith(oldPath + '/')) np = file.path + p.slice(oldPath.length);
      if (np) {
        this.managed[np] = this.managed[p];
        delete this.managed[p];
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  removeAlias(fm, alias) {
    if (fm.aliases == null) return;
    const rest = toArray(fm.aliases).filter((a) => a !== alias);
    if (rest.length) fm.aliases = rest;
    else delete fm.aliases;
  }

  /** Открытый редактор этой заметки (вкладка в режиме редактирования или встраивание), если есть. */
  findEditor(file) {
    const candidates = [this.titleOwners.get(file)];
    this.app.workspace.iterateAllLeaves((leaf) => candidates.push(leaf.view));
    for (const c of candidates) {
      if (!c || c.file !== file || c._loaded === false) continue;
      let editor = null;
      if (MarkdownView && c instanceof MarkdownView) editor = typeof c.getMode === 'function' && c.getMode() === 'source' ? c.editor : null;
      else editor = c.editMode && c.editMode.editor;
      if (editor && typeof editor.getValue === 'function') return editor;
    }
    return null;
  }

  /**
   * Как processFrontMatter, но если заметка открыта в редакторе — правит через редактор:
   * не расходится с несохранённым текстом и не оставляет курсор перед блоком свойств
   * (иначе Enter сразу после ввода имени вставлял перенос перед --- и ломал свойства).
   */
  async editFrontMatter(file, fn) {
    const editor = this.findEditor(file);
    if (!editor) return this.app.fileManager.processFrontMatter(file, fn);

    const text = editor.getValue();
    const m = FRONTMATTER_RE.exec(text);
    let fm = {};
    if (m && m[1] && m[1].trim()) {
      const parsed = parseYaml(m[1]);
      // Свойства не разобрались как объект — не рискуем, пусть Obsidian сам
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return this.app.fileManager.processFrontMatter(file, fn);
      fm = parsed;
    }
    fn(fm);

    const block = Object.keys(fm).length ? `---\n${stringifyYaml(fm)}---\n` : '';
    const oldEnd = m ? m[0].length : 0;
    const cursor = editor.posToOffset(editor.getCursor());
    if (text.slice(0, oldEnd) !== block) editor.replaceRange(block, editor.offsetToPos(0), editor.offsetToPos(oldEnd));
    // Курсор был в начале или внутри свойств — переносим в начало текста под ними
    if (cursor <= oldEnd) editor.setCursor(editor.offsetToPos(block.length));
  }

  async applyTitle(file, original) {
    if (file.extension !== 'md') return;
    const key = this.settings.titleKey;
    try {
      await this.editFrontMatter(file, (fm) => {
        const old = this.managed[file.path];
        if (old) {
          if (old.alias) this.removeAlias(fm, old.alias);
          if (old.key !== key && fm[old.key] === old.title) delete fm[old.key];
        }
        fm[key] = original;
        const rec = { key, title: original };
        if (old && old.heading !== undefined) rec.heading = old.heading;
        if (this.settings.addAlias) {
          const aliases = toArray(fm.aliases);
          if (!aliases.includes(original)) {
            aliases.push(original);
            fm.aliases = aliases;
            rec.alias = original;
          }
        }
        this.managed[file.path] = rec;
      });
      this.scheduleSave();
    } catch (e) {
      console.error('[safe-filename] не удалось записать title', e);
    }
  }

  async cleanupTitle(file) {
    const rec = this.managed[file.path];
    if (!rec || rec.title === undefined) return;
    // Запись о заголовке (# …) оставляем — ею управляет syncHeading
    if (rec.heading !== undefined) this.managed[file.path] = { heading: rec.heading };
    else delete this.managed[file.path];
    this.scheduleSave();
    if (file.extension !== 'md') return;
    try {
      await this.editFrontMatter(file, (fm) => {
        // Удаляем только если значение всё ещё наше (пользователь мог его отредактировать)
        if (fm[rec.key] === rec.title) delete fm[rec.key];
        if (rec.alias) this.removeAlias(fm, rec.alias);
      });
    } catch (e) {
      console.error('[safe-filename] не удалось очистить title', e);
    }
  }

  // ---- Первый заголовок (# …) ---------------------------------------------

  /**
   * Держит первый заголовок заметки равным введённому имени.
   * original — что ввёл пользователь (если известно); иначе берём title, если он про это имя, или имя файла.
   * Для имени, сгенерированного по шаблону, убираем свой заголовок (если пользователь его не менял).
   */
  async syncHeading(file, original) {
    if (!this.settings.syncHeading || file.extension !== 'md') return;
    let text = original != null && original !== '' ? original : null;
    if (text == null && !this.isAutoName(file.basename)) {
      const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
      const t = fm[this.settings.titleKey];
      // title вроде «Вопрос: что?» относится к файлу «Вопрос что» — показываем его, а не очищенное имя
      text = typeof t === 'string' && this.matchesNumbered(file.basename, this.sanitize(t)) ? t : file.basename;
    }

    const rec = this.managed[file.path];
    const prev = rec ? rec.heading : undefined;
    try {
      await this.editHeading(file, text, prev);
    } catch (e) {
      console.error('[safe-filename] не удалось обновить заголовок', e);
      return;
    }
    if (text != null) this.managed[file.path] = Object.assign({}, this.managed[file.path], { heading: text });
    else if (rec) {
      delete rec.heading;
      if (!Object.keys(rec).length) delete this.managed[file.path];
    }
    this.scheduleSave();
  }

  async editHeading(file, text, prev) {
    const editor = this.findEditor(file);
    if (!editor) {
      await this.app.vault.process(file, (doc) => {
        const e = headingEdit(doc, text, prev);
        return e ? doc.slice(0, e.from) + e.insert + doc.slice(e.to) : doc;
      });
      return;
    }
    const e = headingEdit(editor.getValue(), text, prev);
    if (!e) return;
    const cursor = editor.posToOffset(editor.getCursor());
    editor.replaceRange(e.insert, editor.offsetToPos(e.from), editor.offsetToPos(e.to));
    // Курсор стоял в начале текста, куда вставили заголовок, — ставим его под заголовок
    if (e.inserted && cursor === e.from) editor.setCursor(editor.offsetToPos(e.from + e.insert.length));
  }
}

// ---------------------------------------------------------------------------
// Настройки (UI)
// ---------------------------------------------------------------------------

class SafeFilenameSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    new Setting(containerEl)
      .setName('Запрещённые символы')
      .setDesc('Каждый символ из этой строки будет заменён в имени файла.')
      .addText((t) => t.setValue(s.forbidden).onChange(async (v) => { s.forbidden = v; await save(); }));

    new Setting(containerEl)
      .setName('Способ замены')
      .addDropdown((d) => d
        .addOption('char', 'Один символ-заменитель')
        .addOption('lookalike', 'Похожие Unicode-символы (꞉ ？ ∕ …)')
        .setValue(s.replaceMode)
        .onChange(async (v) => { s.replaceMode = v; await save(); }));

    new Setting(containerEl)
      .setName('Символ-заменитель')
      .setDesc('Пробел по умолчанию; повторяющиеся пробелы схлопываются. Пусто — просто удалить символ.')
      .addText((t) => t.setValue(s.replacement).onChange(async (v) => { s.replacement = v; await save(); }));

    const example = () => {
      const sep = s.numberSeparator;
      if (s.duplicateMode !== 'date') return `«Заметка» → «Заметка${sep}1», «Заметка${sep}2», …`;
      return `«Заметка» → «Заметка${sep}${this.plugin.dateSuffix()}»; если и такая есть — ещё и номер`;
    };
    let dupSetting;
    const refresh = () => dupSetting.setDesc(`Если файл уже существует: ${example()}`);

    dupSetting = new Setting(containerEl)
      .setName('При совпадении имени добавлять')
      .addDropdown((d) => d
        .addOption('number', 'Номер')
        .addOption('date', 'Дату и время')
        .setValue(s.duplicateMode)
        .onChange(async (v) => { s.duplicateMode = v; await save(); this.display(); }));
    refresh();

    if (s.duplicateMode === 'date') {
      new Setting(containerEl)
        .setName('Формат даты и времени')
        .setDesc(createFragment((f) => {
          f.appendText('Формат moment.js: YYYY год, MM месяц, DD день, HH часы, mm минуты, ss секунды. ');
          f.createEl('a', { text: 'Все обозначения', href: 'https://momentjs.com/docs/#/displaying/format/' });
        }))
        .addText((t) => t
          .setPlaceholder(DEFAULT_SETTINGS.duplicateDateFormat)
          .setValue(s.duplicateDateFormat)
          .onChange(async (v) => { s.duplicateDateFormat = v; await save(); refresh(); }));
    }

    new Setting(containerEl)
      .setName('Разделитель')
      .setDesc('Между именем и номером или датой.')
      .addText((t) => t.setValue(s.numberSeparator).onChange(async (v) => { s.numberSeparator = v; await save(); refresh(); }));

    new Setting(containerEl)
      .setName('Разрешить пустое имя')
      .setDesc('Если стереть имя целиком, файл получит имя по умолчанию вместо ошибки.')
      .addToggle((t) => t.setValue(s.allowEmpty).onChange(async (v) => { s.allowEmpty = v; await save(); }));

    let nameSetting;
    const nameDesc = () => nameSetting.setDesc(`Для новых файлов и пустого ввода. Можно {{date:ФОРМАТ}}, пусто — {{date}}. Сейчас получится: «${this.plugin.emptyBase()}».`);
    nameSetting = new Setting(containerEl)
      .setName('Имя по умолчанию')
      .addText((t) => t.setPlaceholder(DEFAULT_EMPTY_NAME).setValue(s.emptyName).onChange(async (v) => { s.emptyName = v; await save(); nameDesc(); }));
    nameDesc();

    new Setting(containerEl)
      .setName('Скрывать предупреждения о недопустимом имени')
      .setDesc('Плагин всё равно исправит имя при сохранении.')
      .addToggle((t) => t.setValue(s.suppressWarnings).onChange(async (v) => { s.suppressWarnings = v; await save(); }));

    new Setting(containerEl)
      .setName('Ссылки с недопустимыми символами')
      .setDesc('Что делать при переходе по ссылке вида [[name?]] на несуществующую заметку.')
      .addDropdown((d) => d
        .addOption('fix', 'Создать заметку и исправить ссылку: [[name|name?]]')
        .addOption('block', 'Не создавать, показать подсказку')
        .setValue(s.brokenLinks)
        .onChange(async (v) => { s.brokenLinks = v; await save(); }));

    new Setting(containerEl)
      .setName('Свойство для исходного имени')
      .addText((t) => t.setValue(s.titleKey).onChange(async (v) => { s.titleKey = v; await save(); }));

    new Setting(containerEl)
      .setName('Когда записывать title')
      .setDesc('Записанное плагином удаляется при следующем переименовании, если вы его не меняли.')
      .addDropdown((d) => d
        .addOption('changed', 'Только если имя пришлось изменить')
        .addOption('always', 'При любом переименовании')
        .setValue(s.titleMode)
        .onChange(async (v) => { s.titleMode = v; await save(); }));

    new Setting(containerEl)
      .setName('Синхронизировать с первым заголовком (# …)')
      .setDesc('При переименовании первая строка заметки «# …» становится введённым именем со всеми символами; если её нет — добавляется.')
      .addToggle((t) => t.setValue(s.syncHeading).onChange(async (v) => { s.syncHeading = v; await save(); }));

    new Setting(containerEl)
      .setName('Добавлять исходное имя в aliases')
      .addToggle((t) => t.setValue(s.addAlias).onChange(async (v) => { s.addAlias = v; await save(); }));

    new Setting(containerEl)
      .setName('Исправлять имена при программном создании файлов')
      .setDesc('Создание по ссылке, из шаблонов, других плагинов.')
      .addToggle((t) => t.setValue(s.interceptCreate).onChange(async (v) => { s.interceptCreate = v; await save(); }));
  }
}

module.exports = SafeFilenamePlugin;
module.exports.default = SafeFilenamePlugin;
module.exports._internal = { sanitizeName, normalizeEditable, replaceWikilinks, headingEdit, DEFAULT_SETTINGS };
