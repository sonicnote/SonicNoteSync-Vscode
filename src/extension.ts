import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SonicNoteApiClient } from './api';
import { SyncService } from './sync';
import { SonicNoteSettings, DEFAULT_SETTINGS, BUILTIN_FRONTMATTER_FIELDS, CustomFrontmatterField } from './types';

let apiClient: SonicNoteApiClient;
let syncService: SyncService;
let statusBarItem: vscode.StatusBarItem;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncing = false;
let sidebarProvider: SidebarViewProvider;
let extensionContext: vscode.ExtensionContext;

const STATE_KEYS = {
  token: 'sonicnote.token',
  apiKey: 'sonicnote.apiKey',
  lastSyncTime: 'sonicnote.lastSyncTime',
  frontmatterFields: 'sonicnote.frontmatterFields',
  customFrontmatter: 'sonicnote.customFrontmatter',
};

function getState<T>(key: string, fallback: T): T {
  try {
    if (extensionContext) {
      return extensionContext.globalState.get<T>(key, fallback);
    }
  } catch {}
  return fallback;
}

async function setState(key: string, value: any): Promise<void> {
  await extensionContext.globalState.update(key, value);
}

function getSettings(): SonicNoteSettings {
  const config = vscode.workspace.getConfiguration('sonicnote-sync');
  return {
    serverUrl: config.get<string>('serverUrl', DEFAULT_SETTINGS.serverUrl),
    syncFolder: config.get<string>('syncFolder', '') || '',
    pageSize: config.get<number>('pageSize', DEFAULT_SETTINGS.pageSize),
    includeTranscript: config.get<boolean>('includeTranscript', DEFAULT_SETTINGS.includeTranscript),
    autoSyncOnOpen: config.get<boolean>('autoSyncOnOpen', DEFAULT_SETTINGS.autoSyncOnOpen),
    resyncIntervalMinutes: config.get<number>('resyncIntervalMinutes', DEFAULT_SETTINGS.resyncIntervalMinutes),
    frontmatterFields: getState<Record<string, boolean>>(STATE_KEYS.frontmatterFields, DEFAULT_SETTINGS.frontmatterFields),
    customFrontmatter: getState<CustomFrontmatterField[]>(STATE_KEYS.customFrontmatter, DEFAULT_SETTINGS.customFrontmatter),
    token: getState<string>(STATE_KEYS.token, DEFAULT_SETTINGS.token),
    apiKey: getState<string>(STATE_KEYS.apiKey, DEFAULT_SETTINGS.apiKey),
    lastSyncTime: getState<string>(STATE_KEYS.lastSyncTime, DEFAULT_SETTINGS.lastSyncTime),
  };
}

// ============= SidebarViewProvider (WebviewView) =============

class SidebarViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();
    webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
  }

  refresh() {
    if (this._view) {
      this._view.webview.html = this.buildHtml();
    }
  }

  private handleMessage(msg: any) {
    switch (msg.command) {
      case 'openSettings':
        vscode.commands.executeCommand('sonicnote-sync.openSettings');
        break;
      case 'sync':
        vscode.commands.executeCommand('sonicnote-sync.sync');
        break;
      case 'openFile': {
        const uri = vscode.Uri.file(msg.path);
        vscode.commands.executeCommand('vscode.open', uri);
        break;
      }
      case 'revealInFinder': {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.dirname(msg.path)));
        break;
      }
      case 'copyPath': {
        vscode.env.clipboard.writeText(msg.path);
        vscode.window.showInformationMessage('已复制路径到剪贴板');
        break;
      }
      case 'copyContent': {
        try {
          const content = fs.readFileSync(msg.path, 'utf-8');
          vscode.env.clipboard.writeText(content);
          vscode.window.showInformationMessage('已复制到剪贴板');
        } catch (e) {
          vscode.window.showErrorMessage(`复制失败: ${e instanceof Error ? e.message : ''}`);
        }
        break;
      }
      case 'deleteFile': {
        const fname = path.basename(msg.path);
        vscode.window.showWarningMessage(
          `确定删除 "${fname}"？`, { modal: true }, '删除'
        ).then(confirm => {
          if (confirm !== '删除') return;
          try {
            fs.unlinkSync(msg.path);
            this.refresh();
            vscode.window.showInformationMessage(`已删除: ${fname}`);
          } catch (e) {
            vscode.window.showErrorMessage(`删除失败: ${e instanceof Error ? e.message : ''}`);
          }
        });
        break;
      }
    }
  }

  private getFileList(): Array<{ name: string; path: string; mtime: number }> {
    const dir = getSettings().syncFolder;
    if (!dir || !fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const fp = path.join(dir, f);
          const stat = fs.statSync(fp);
          return { name: f, path: fp, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  private buildHtml(): string {
    const dir = getSettings().syncFolder;
    const files = this.getFileList();

    let fileRows = '';
    if (!dir) {
      fileRows = `<div class="hint-row" onclick="post('openSettings')">⚙️ 请在设置中配置同步文件夹</div>`;
    } else if (!fs.existsSync(dir)) {
      fileRows = `<div class="hint-row">⚠️ 目录不存在: ${this.escAttr(dir)}</div>`;
    } else if (files.length === 0) {
      fileRows = `<div class="hint-row">📭 暂无 .md 文件</div>`;
    } else {
      fileRows = files.map(f => {
        const name = this.escAttr(f.name);
        const fpath = this.escAttr(f.path);
        return `<div class="file-row" data-path="${fpath}"
          onclick="post('openFile', '${fpath}')"
          oncontextmenu="showCtx(event, '${fpath}', '${name}')">
          <span class="file-icon">📄</span><span class="file-name">${name}</span>
        </div>`;
      }).join('');
    }

    const dirDisplay = dir ? this.escAttr(dir) : '未配置';

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{padding:8px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px;user-select:none}
/* Button row */
.btn-row{display:flex;gap:8px;margin-bottom:10px}
.sidebar-btn{flex:1;padding:6px 0;border:1px solid var(--vscode-button-border,var(--vscode-button-background));border-radius:4px;background:var(--vscode-button-secondaryBackground,var(--vscode-button-background));color:var(--vscode-button-secondaryForeground,var(--vscode-button-foreground));cursor:pointer;font-size:12px;font-family:inherit;text-align:center;white-space:nowrap}
.sidebar-btn:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-button-hoverBackground))}
.sidebar-btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:500}
.sidebar-btn.primary:hover{background:var(--vscode-button-hoverBackground)}
/* Divider */
.divider{border:none;border-top:1px solid var(--vscode-sideBarSectionHeader-border);margin:8px 0}
/* Section header */
.section-title{font-size:13px;font-weight:600;color:var(--vscode-sideBarTitle-foreground);padding:4px 4px 6px}
/* File list */
.file-list{display:flex;flex-direction:column;gap:1px}
.file-row{display:flex;align-items:center;gap:6px;padding:4px;border-radius:3px;cursor:pointer}
.file-row:hover{background:var(--vscode-list-hoverBackground)}
.file-icon{font-size:13px;flex-shrink:0}
.file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.hint-row{padding:6px 4px;font-size:12px;color:var(--vscode-descriptionForeground);cursor:pointer}
.hint-row:hover{color:var(--vscode-foreground)}
/* Context menu */
.ctx-menu{display:none;position:fixed;z-index:1000;min-width:160px;background:var(--vscode-menu-background);border:1px solid var(--vscode-menu-border);border-radius:4px;padding:4px 0;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.ctx-menu.show{display:block}
.ctx-item{display:flex;align-items:center;gap:8px;padding:4px 12px;cursor:pointer;font-size:12px;color:var(--vscode-menu-foreground)}
.ctx-item:hover{background:var(--vscode-menu-selectionBackground);color:var(--vscode-menu-selectionForeground)}
.ctx-sep{border:none;border-top:1px solid var(--vscode-menu-separatorBackground);margin:4px 0}
</style></head><body>
<div class="btn-row">
  <button class="sidebar-btn primary" onclick="post('openSettings')">⚙️ 插件设置</button>
  <button class="sidebar-btn primary" onclick="post('sync')">🔄 文件同步</button>
</div>
<hr class="divider">
<div class="section-title">📁 文件目录</div>
<div class="file-list">${fileRows}</div>
<div id="ctxMenu" class="ctx-menu">
  <div class="ctx-item" onclick="ctxAction('open')"><span>📄</span> 打开文件</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" onclick="ctxAction('reveal')"><span>📂</span> 打开目录</div>
  <div class="ctx-item" onclick="ctxAction('copyContent')"><span>📋</span> 复制内容</div>
  <div class="ctx-item" onclick="ctxAction('copyPath')"><span>📎</span> 复制路径</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" onclick="ctxAction('delete')"><span>🗑️</span> 删除文件</div>
</div>
<script>
const V=acquireVsCodeApi();
let ctxPath='',ctxName='';
function post(cmd,path){V.postMessage({command:cmd,path:path||''})}
function showCtx(e,path,name){e.preventDefault();ctxPath=path;ctxName=name;var m=document.getElementById('ctxMenu');m.classList.add('show');m.style.removeProperty('bottom');m.style.removeProperty('top');m.style.left=e.clientX+'px';var h=m.offsetHeight,w=window.innerHeight;if(e.clientY+h>w-8){m.style.bottom=(w-e.clientY)+'px';m.style.top='auto'}else{m.style.top=e.clientY+'px';m.style.bottom='auto'}}
function ctxAction(action){
  document.getElementById('ctxMenu').classList.remove('show');
  switch(action){
    case 'open': post('openFile',ctxPath);break;
    case 'reveal': post('revealInFinder',ctxPath);break;
    case 'copyContent': post('copyContent',ctxPath);break;
    case 'copyPath': post('copyPath',ctxPath);break;
    case 'delete': post('deleteFile',ctxPath);break;
  }
}
document.addEventListener('click',function(){document.getElementById('ctxMenu').classList.remove('show')});
</script></body></html>`;
  }

  private escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

// ============= Extension Lifecycle =============

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  console.log('SonicNote Sync extension activated');

  apiClient = new SonicNoteApiClient(getSettings);
  syncService = new SyncService(apiClient, getSettings, async (t: string) => {
    await setState(STATE_KEYS.lastSyncTime, t);
  });

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'sonicnote-sync.sync';
  statusBarItem.tooltip = 'SonicNote Sync';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  sidebarProvider = new SidebarViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('sonicnote-sync.sidebarView', sidebarProvider)
  );

  context.subscriptions.push(vscode.commands.registerCommand('sonicnote-sync.sync', () => triggerSync()));
  context.subscriptions.push(vscode.commands.registerCommand('sonicnote-sync.login', () => loginFlow()));
  context.subscriptions.push(vscode.commands.registerCommand('sonicnote-sync.logout', async () => {
    await setState(STATE_KEYS.token, ''); await setState(STATE_KEYS.apiKey, '');
    vscode.window.showInformationMessage('已登出 SonicNote');
    updateStatusBar();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('sonicnote-sync.openSettings', () => openSettingsPanel()));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('sonicnote-sync')) {
      sidebarProvider.refresh();
      startAutoSync(); updateStatusBar();
    }
  }));

  const settings = getSettings();
  if (settings.autoSyncOnOpen && apiClient.isAuthenticated()) {
    setTimeout(() => triggerSync(), 5000);
  }
  startAutoSync();
}

export function deactivate() {
  stopAutoSync();
  statusBarItem?.dispose();
}

// ============= Login / Sync =============

async function loginFlow(): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    prompt: '请输入 SonicNote API Key',
    placeHolder: 'sk-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    password: true, ignoreFocusOut: true,
  });
  if (!apiKey) return;
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在登录 SonicNote...', cancellable: false },
      async () => apiClient.login(apiKey)
    );
    await setState(STATE_KEYS.token, result.token);
    await setState(STATE_KEYS.apiKey, apiKey);
    vscode.window.showInformationMessage('登录成功');
    updateStatusBar(); startAutoSync();
  } catch (e) {
    vscode.window.showErrorMessage(`登录失败: ${e instanceof Error ? e.message : '未知错误'}`);
  }
}

async function triggerSync() {
  if (!apiClient.isAuthenticated()) {
    const action = await vscode.window.showWarningMessage('请先登录 SonicNote', '登录');
    if (action === '登录') { await loginFlow(); }
    return;
  }
  if (syncing) { vscode.window.showInformationMessage('同步已在进行中'); return; }
  syncing = true; stopAutoSync();
  statusBarItem.text = '$(sync~spin) SonicNote: 同步中...'; statusBarItem.show();

  try {
    const result = await syncService.syncAll((msg) => {
      statusBarItem.text = `$(sync~spin) SonicNote: ${msg}`; statusBarItem.show();
    });
    let message = `同步完成: ${result.synced} 条新/更新`;
    if (result.skipped > 0) message += `, ${result.skipped} 条跳过`;
    if (result.errors > 0) message += `, ${result.errors} 条失败`;
    vscode.window.showInformationMessage(message);
  } catch (e) {
    vscode.window.showErrorMessage(`同步失败: ${e instanceof Error ? e.message : '未知错误'}`);
  } finally {
    syncing = false; updateStatusBar(); sidebarProvider.refresh(); startAutoSync();
  }
}

function updateStatusBar() {
  if (apiClient.isAuthenticated()) {
    const t = getState<string>(STATE_KEYS.lastSyncTime, '');
    statusBarItem.text = '$(sync) SonicNote: ' + (t ? `上次同步: ${t}` : '未同步');
    statusBarItem.tooltip = 'SonicNote Sync - 点击同步';
  } else {
    statusBarItem.text = '$(sync) SonicNote: 未登录';
    statusBarItem.tooltip = 'SonicNote Sync - 点击登录';
  }
  statusBarItem.show();
}

function startAutoSync() {
  stopAutoSync();
  const s = getSettings();
  if (s.resyncIntervalMinutes > 0 && apiClient.isAuthenticated()) {
    syncTimer = setInterval(() => triggerSync(), s.resyncIntervalMinutes * 60 * 1000);
  }
}

function stopAutoSync() {
  if (syncTimer !== null) { clearInterval(syncTimer); syncTimer = null; }
}

// ============= Settings Webview Panel =============

let settingsPanel: vscode.WebviewPanel | undefined;

async function saveSetting(key: string, value: any) {
  if (['frontmatterFields', 'customFrontmatter'].includes(key)) {
    await setState(STATE_KEYS[key as keyof typeof STATE_KEYS], value);
  } else {
    const config = vscode.workspace.getConfiguration('sonicnote-sync');
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }
  sidebarProvider.refresh();
  startAutoSync(); updateStatusBar();
}

function openSettingsPanel() {
  if (settingsPanel) { settingsPanel.reveal(); return; }

  settingsPanel = vscode.window.createWebviewPanel(
    'sonicnote-sync-settings', 'SonicNote Sync 设置', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  settingsPanel.onDidDispose(() => { settingsPanel = undefined; });

  settingsPanel.webview.onDidReceiveMessage(async (msg: any) => {
    switch (msg.command) {
      case 'getSettings':
        settingsPanel?.webview.postMessage({
          command: 'settingsData', data: getSettings(), isAuthed: apiClient.isAuthenticated(),
        });
        break;
      case 'setSetting':
        await saveSetting(msg.key, msg.value);
        break;
      case 'login':
        try {
          const r = await apiClient.login(msg.apiKey);
          await setState(STATE_KEYS.token, r.token);
          await setState(STATE_KEYS.apiKey, msg.apiKey);
          settingsPanel?.webview.postMessage({ command: 'loginResult', success: true });
          updateStatusBar(); startAutoSync();
        } catch (e) {
          settingsPanel?.webview.postMessage({ command: 'loginResult', success: false, error: e instanceof Error ? e.message : '登录失败' });
        }
        break;
      case 'logout':
        await setState(STATE_KEYS.token, '');
        await setState(STATE_KEYS.apiKey, '');
        settingsPanel?.webview.postMessage({ command: 'logoutDone' });
        updateStatusBar();
        break;
      case 'selectFolder': {
        const folders = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: '选择同步文件夹',
          title: '选择录音 Markdown 文件存放目录',
        });
        if (folders && folders.length > 0) {
          const dir = folders[0].fsPath;
          await saveSetting('syncFolder', dir);
          settingsPanel?.webview.postMessage({ command: 'folderSelected', path: dir });
        }
        break;
      }
    }
  });

  settingsPanel.webview.html = buildSettingsHtml();
}

function buildSettingsHtml(): string {
  const builtinFields = JSON.stringify(BUILTIN_FRONTMATTER_FIELDS);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{padding:20px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px}
h2{font-size:18px;margin-bottom:20px;padding-bottom:8px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border)}
h3{font-size:14px;margin:20px 0 10px}
.section{margin-bottom:20px}
.setting-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border)}
.setting-label{flex:1}
.setting-label .name{font-weight:500}
.setting-label .desc{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}
.setting-label .key{font-family:monospace;font-size:10px;color:var(--vscode-textPreformat-foreground)}
input[type="text"],input[type="password"],select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:4px 8px;font-family:var(--vscode-font-family);font-size:13px;width:200px}
select{width:auto}
input[type="checkbox"]{width:16px;height:16px;accent-color:var(--vscode-focusBorder)}
.btn{padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-family:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.btn.small{padding:3px 8px;font-size:11px}
.btn.danger{background:#c62828;color:#fff}
.btn.danger:hover{background:#e53935}
.status-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
.status-badge.ok{background:#2e7d32;color:#fff}
.status-badge.warn{background:#e65100;color:#fff}
.custom-row{display:flex;gap:8px;margin-bottom:6px;align-items:center}
.custom-row input{flex:1}
.toast{position:fixed;top:12px;right:12px;padding:10px 16px;border-radius:4px;font-size:13px;z-index:999;opacity:0;transition:opacity .3s}
.toast.show{opacity:1}
.toast.success{background:#2e7d32;color:#fff}
.toast.error{background:#c62828;color:#fff}
.required-tag{font-size:10px;color:var(--vscode-descriptionForeground);background:var(--vscode-textCodeBlock-background);padding:1px 6px;border-radius:3px}
.folder-right{display:flex;align-items:center;gap:8px;flex-shrink:0;max-width:60%}
.folder-path{font-family:monospace;font-size:11px;color:var(--vscode-textPreformat-foreground);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;direction:rtl;text-align:left}
.folder-path:empty::after{content:'未选择';color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);direction:ltr}
.folder-path:hover{opacity:0.7}
</style></head><body>
<h2>SonicNote Sync 设置</h2>
<div class="section"><h3>同步</h3>
<div class="setting-row"><div class="setting-label"><div class="name">同步文件夹</div><div class="desc">录音 Markdown 文件存放的目录</div></div><div class="folder-right"><span id="syncFolderPath" class="folder-path" onclick="selectFolder()"></span><button class="btn" onclick="selectFolder()">📁 选择</button></div></div>
<div class="setting-row"><div class="setting-label"><div class="name">包含转录内容</div><div class="desc">关闭后同步的文件中不包含逐字转录内容</div></div><input type="checkbox" id="includeTranscript" onchange="setSetting('includeTranscript',this.checked)"/></div>
<div class="setting-row"><div class="setting-label"><div class="name">启动时自动同步</div><div class="desc">每次打开 VSCode 时自动执行一次同步</div></div><input type="checkbox" id="autoSyncOnOpen" onchange="setSetting('autoSyncOnOpen',this.checked)"/></div>
<div class="setting-row"><div class="setting-label"><div class="name">定时重同步</div><div class="desc">VSCode 打开期间按指定间隔自动重新同步</div></div><select id="resyncIntervalMinutes" onchange="setSetting('resyncIntervalMinutes',parseInt(this.value)||0)"><option value="0">关闭（手动同步）</option><option value="60">每 1 小时</option><option value="180">每 3 小时</option><option value="360">每 6 小时</option><option value="1440">每 24 小时</option></select></div>
</div>
<div class="section"><h3>文件属性</h3><div class="desc" style="margin-bottom:10px;">选择同步到 Frontmatter 中的属性字段</div><div id="builtinFields"></div></div>
<div class="section"><h3>自定义属性</h3><div class="desc" style="margin-bottom:10px;">添加自定义属性到所有同步文件的 Frontmatter 中</div><div id="customFields"></div><button class="btn small" onclick="addCustomField()" style="margin-top:8px;">+ 添加</button></div>
<div class="section"><h3>账号</h3><div id="accountSection"></div></div>
<div id="toast" class="toast"></div>
<script>
const vscode = acquireVsCodeApi();
let currentData={},currentCustomFields=[],isAuthed=false;
const BUILTIN_FIELDS=${builtinFields};
const REQUIRED_FIELDS=['audio_id','sync_time'];
window.addEventListener('message',e=>{
 const m=e.data;
 if(m.command==='settingsData'){currentData=m.data;isAuthed=m.isAuthed;populateForm(m.data);}
 else if(m.command==='loginResult'){if(m.success){showToast('登录成功','success');isAuthed=true;renderAccountSection();vscode.postMessage({command:'getSettings'});}else{showToast('登录失败: '+(m.error||'未知错误'),'error');var b=document.getElementById('loginBtn');if(b){b.disabled=false;b.textContent='登录';}}}
 else if(m.command==='logoutDone'){isAuthed=false;renderAccountSection();showToast('已登出','success');}
 else if(m.command==='folderSelected'){document.getElementById('syncFolderPath').textContent=m.path;}
});
function selectFolder(){vscode.postMessage({command:'selectFolder'});}
function setSetting(k,v){
 currentData[k]=v;
 vscode.postMessage({command:'setSetting',key:k,value:v});
 showToast('已保存','success');
}
function populateForm(d){
 document.getElementById('syncFolderPath').textContent=d.syncFolder||'';
 document.getElementById('includeTranscript').checked=d.includeTranscript!==false;
 document.getElementById('autoSyncOnOpen').checked=d.autoSyncOnOpen===true;
 document.getElementById('resyncIntervalMinutes').value=String(d.resyncIntervalMinutes||0);
 renderBuiltinFields(d.frontmatterFields||{});
 currentCustomFields=d.customFrontmatter||[];
 renderCustomFields();renderAccountSection();
}
function renderBuiltinFields(f){
 var c=document.getElementById('builtinFields'),h='';
 for(var k in BUILTIN_FIELDS){
  var r=REQUIRED_FIELDS.indexOf(k)>=0;
  h+='<div class="setting-row"><div class="setting-label"><div class="name">'+BUILTIN_FIELDS[k]+(r?' <span class="required-tag">必要属性</span>':'')+'</div><div class="key">'+k+'</div></div>';
  h+=r?'<div class="required-tag">必要属性</div>':'<input type="checkbox" '+(f[k]!==false?'checked':'')+' onchange="toggleField(\\''+k+'\\',this.checked)"/>';
  h+='</div>';
 }
 c.innerHTML=h;
}
function toggleField(k,v){
 if(!currentData.frontmatterFields)currentData.frontmatterFields={};
 currentData.frontmatterFields[k]=v;
 setSetting('frontmatterFields',currentData.frontmatterFields);
}
function renderCustomFields(){
 var c=document.getElementById('customFields'),h='';
 currentCustomFields.forEach(function(f,i){
  h+='<div class="custom-row"><input type="text" placeholder="属性名" value="'+esc(f.key||'')+'" onchange="updateCustomKey('+i+',this.value)"/><input type="text" placeholder="属性值" value="'+esc(f.value||'')+'" onchange="updateCustomValue('+i+',this.value)"/><button class="btn small danger" onclick="removeCustomField('+i+')">🗑</button></div>';
 });
 c.innerHTML=h||'<div class="desc">暂无自定义属性</div>';
}
function addCustomField(){currentCustomFields.push({key:'',value:''});renderCustomFields();saveCustomFields();}
function removeCustomField(i){currentCustomFields.splice(i,1);renderCustomFields();saveCustomFields();}
function updateCustomKey(i,v){currentCustomFields[i].key=v;saveCustomFields();}
function updateCustomValue(i,v){currentCustomFields[i].value=v;saveCustomFields();}
function saveCustomFields(){setSetting('customFrontmatter',currentCustomFields);}
function renderAccountSection(){
 var c=document.getElementById('accountSection');
 if(isAuthed){
  c.innerHTML='<div class="setting-row"><div class="setting-label"><div class="name">登录状态 <span class="status-badge ok">已登录</span></div></div><button class="btn danger" onclick="doLogout()">登出</button></div>';
 }else{
  c.innerHTML='<div class="setting-row"><div class="setting-label"><div class="name">登录 <span class="status-badge warn">未登录</span></div><div class="desc">使用 API Key 登录 SonicNote（在妙记 App → 我的 → MCP Key 管理中创建）</div></div><div style="display:flex;align-items:center;gap:10px;"><input type="password" id="apiKeyInput" placeholder="sk-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style="width:280px;"/><button class="btn" id="loginBtn" onclick="doLogin()">登录</button></div></div>';
 }
}
function doLogin(){
 var i=document.getElementById('apiKeyInput'),k=i?i.value.trim():'';
 if(!k){showToast('请输入 API Key','error');return;}
 document.getElementById('loginBtn').disabled=true;
 document.getElementById('loginBtn').textContent='登录中...';
 vscode.postMessage({command:'login',apiKey:k});
}
function doLogout(){vscode.postMessage({command:'logout'});}
function showToast(m,t){var o=document.getElementById('toast');o.textContent=m;o.className='toast '+t+' show';clearTimeout(o._tid);o._tid=setTimeout(function(){o.className='toast';},2000);}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
vscode.postMessage({command:'getSettings'});
</script></body></html>`;
}
