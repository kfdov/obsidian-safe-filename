// Минимальная имитация внутренностей Obsidian 1.13.7 (по app.js)
const HD = /[\\/:*?"<>|]/, zD = /[#^[\]|]/;
class TAbstractFile {}
class TFolder extends TAbstractFile {
  constructor(v, path, parent) { super(); this.vault = v; this.path = path; this.name = path.split('/').pop(); this.parent = parent; this.children = []; }
}
class TFile extends TAbstractFile {
  constructor(v, path, parent) { super(); this.vault = v; this.parent = parent; this._set(path); }
  _set(p) { this.path = p; this.name = p.split('/').pop(); const d = this.name.lastIndexOf('.'); this.basename = this.name.slice(0, d); this.extension = this.name.slice(d + 1); }
  getNewPathAfterRename(n) { return (this.parent.path === '/' ? '' : this.parent.path + '/') + n + '.' + this.extension; }
}
function checkPath(p) { if (p.split('/').some((s) => HD.test(s))) throw new Error('File name cannot contain...'); }
function HP(app, file, n, empty) {
  return HD.test(n) ? 'ERR invalid chars' : empty && n === '' ? 'ERR empty' : n.startsWith('.') ? 'ERR dot' : app.vault.checkForDuplicate(file, n) ? 'ERR exists' : '';
}
const warnings = [];
class YZ {
  constructor(app, file) { this.app = app; this.file = file; this.fileBeingRenamed = null; }
  onTitleChange(el) { const n = el.textContent.trim(); const e = HP(this.app, this.file, n, false) || (zD.test(n) ? 'ERR unsafe' : ''); if (e) warnings.push(e); }
  async saveTitle(el) {
    if (this.file !== this.fileBeingRenamed) return;
    const o = el.textContent.trim();
    const e = HP(this.app, this.file, o, true);
    if (e) { warnings.push(e); el.textContent = this.file.basename; return; }
    const s = this.file.getNewPathAfterRename(o);
    if (s === this.file.path) return;
    await this.app.fileManager.renameFile(this.file, s);
  }
}
class MarkdownView extends YZ {}
class Modal { constructor(app) { this.app = app; } open() { this.opened = true; } close() {} }
class Plugin {
  constructor(app) { this.app = app; }
  registerEvent() {} registerDomEvent() {} addSettingTab() {}
  async loadData() { return null; } async saveData(d) { this._saved = d; }
}
class PluginSettingTab {}
const notices = [];
class Notice { constructor(t) { notices.push(t); } }
function parseLinktext(lt) { const i = lt.indexOf("#"); return i < 0 ? { path: lt, subpath: "" } : { path: lt.slice(0, i), subpath: lt.slice(i) }; }
class WorkspaceLeaf {
  constructor(app) { this.app = app; }
  async openLinkText(lt, src) {
    const { path } = parseLinktext(lt);
    let f = this.app.metadataCache.getFirstLinkpathDest(path, src);
    if (!f) f = await this.app.fileManager.createNewFile(path.includes("/") ? null : this.app.fileManager.getNewFileParent(src), path);
    this.opened = f;
  }
}
class Setting {}
module.exports = {
  Plugin, PluginSettingTab, Setting, Modal, Notice, WorkspaceLeaf, parseLinktext, _notices: notices, MarkdownView, TAbstractFile, TFile, TFolder,
  _YZ: YZ, _HP: HP, _HD: HD, _zD: zD, _checkPath: checkPath, _warnings: warnings,
  normalizePath: (p) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
  moment: () => ({ format: (f) => ({ MMDDHHmmss: '1005143012', 'HH:mm': '14:30' }[f] || '2026-10-05 06-50') }),
};
