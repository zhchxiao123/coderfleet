// ── 已完成任务日志的跨刷新持久缓存（IndexedDB）── issue #43
//
// done/failed/killed 任务的日志内容确定不再变化，但 _finishedLogCache（state.js）只是
// 内存里的 Map，页面一刷新就清空——刷新一次就要把这些任务的日志重新整份下载解析一遍。
// 这里加一层 IndexedDB 持久层：_fetchTaskLogCached() 命中内存缓存前先查 IndexedDB，
// 拉取到网络内容后既写内存缓存也落一份到这里，刷新页面后仍然命中。

const LOG_CACHE_DB_NAME    = 'coderfleet-log-cache';
const LOG_CACHE_STORE      = 'logs';
const LOG_CACHE_MAX_ENTRIES = 300; // 超过这个条数，按写入时间淘汰最老的，避免无限占用本地存储
const LOG_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const LOG_MEMORY_MAX_BYTES = 16 * 1024 * 1024;
const _finishedLogCache = new Map();
const _logRequests = new Map();
const _logQueue = [];
let _logActiveRequests = 0;

let _logCacheDbPromise = null;
let _logCacheEviction = null;
let _logCacheEvictionDirty = false;

function _reqToPromise(req) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(()=>reject(new Error('Log cache read timed out')),1000);
    req.onsuccess = () => {clearTimeout(timer);resolve(req.result);};
    req.onerror = () => {clearTimeout(timer);reject(req.error);};
  });
}

function _openLogCacheDb() {
  if (_logCacheDbPromise) return _logCacheDbPromise;
  _logCacheDbPromise = new Promise(resolve => {
    if (!window.indexedDB) { resolve(null); return; }
    let req;
    try {
      req = indexedDB.open(LOG_CACHE_DB_NAME, 1);
    } catch (e) { resolve(null); return; }
    let settled = false;
    const finish = db => {if (settled) {db?.close();return;} settled=true;clearTimeout(timer);resolve(db);};
    const timer = setTimeout(()=>finish(null),1000);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOG_CACHE_STORE)) {
        const store = db.createObjectStore(LOG_CACHE_STORE, { keyPath: 'taskId' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {req.result.close();_logCacheDbPromise=null;};
      finish(req.result);
    };
    req.onerror = () => finish(null);
    req.onblocked = () => finish(null);
  });
  return _logCacheDbPromise;
}

// 读取某个任务缓存的日志正文；没有持久缓存环境或未命中都返回 null
async function logCacheGet(taskId) {
  const db = await _openLogCacheDb();
  if (!db) return null;
  try {
    const tx = db.transaction(LOG_CACHE_STORE, 'readonly');
    const record = await _reqToPromise(tx.objectStore(LOG_CACHE_STORE).get(taskId));
    return record?.version === 2 ? record.text : null;
  } catch (e) {
    return null;
  }
}

// 清掉某个任务的持久缓存条目——发现缓存里是一份没收尾的半成品（工具调用状态卡死）
// 时用来自愈，逼下一次 _fetchTaskLogCached 老老实实重新拉一遍。
async function logCacheDelete(taskId) {
  const db = await _openLogCacheDb();
  if (!db) return;
  try {
    const tx = db.transaction(LOG_CACHE_STORE, 'readwrite');
    tx.objectStore(LOG_CACHE_STORE).delete(taskId);
  } catch (e) {
    return;
  }
}

// 写入某个任务的日志正文；失败（配额满/被禁用）静默忽略，不影响页面功能
async function logCacheSet(taskId, text) {
  const db = await _openLogCacheDb();
  if (!db) return;
  try {
    const tx = db.transaction(LOG_CACHE_STORE, 'readwrite');
    if (text.length * 2 > LOG_MEMORY_MAX_BYTES) return;
    tx.objectStore(LOG_CACHE_STORE).put({ taskId, text, savedAt: Date.now(), bytes: text.length * 2, version: 2 });
  } catch (e) {
    return;
  }
  _logCacheEvictionDirty = true;
  if (!_logCacheEviction) {
    _logCacheEviction = (async()=> {
      while (_logCacheEvictionDirty) {
        _logCacheEvictionDirty = false;
        await _evictOldLogCacheEntries(db);
      }
    })().catch(()=>{}).finally(()=>{_logCacheEviction=null;});
  }
}

async function _evictOldLogCacheEntries(db) {
  const tx = db.transaction(LOG_CACHE_STORE, 'readwrite');
  const index = tx.objectStore(LOG_CACHE_STORE).index('savedAt');
  let count = 0, bytes = 0;
  await new Promise(resolve => {
    const cursorReq = index.openCursor(null, 'prev');
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) { resolve(); return; }
      const record = cursor.value;
      const size = record.bytes || (record.text || '').length * 2;
      if (record.version !== 2 || count >= LOG_CACHE_MAX_ENTRIES || bytes + size > LOG_CACHE_MAX_BYTES) cursor.delete();
      else { count++; bytes += size; }
      cursor.continue();
    };
    cursorReq.onerror = () => resolve();
  });
}

function _rememberTaskLog(taskId, text) {
  _finishedLogCache.delete(taskId);
  if (text.length * 2 > LOG_MEMORY_MAX_BYTES) return;
  _finishedLogCache.set(taskId,text);
  let bytes = 0;
  for (const value of _finishedLogCache.values()) bytes += value.length * 2;
  while (bytes > LOG_MEMORY_MAX_BYTES || _finishedLogCache.size > LOG_CACHE_MAX_ENTRIES) {
    const id = _finishedLogCache.keys().next().value;
    bytes -= _finishedLogCache.get(id).length * 2;
    _finishedLogCache.delete(id);
  }
}

function _looksLikeCompleteTaskLog(text) {
  return /(?:^|\n)={6,}[^\n]*\n\s*(?:finished:|usage status:)/.test(text || '');
}

function _drainLogQueue() {
  while (_logActiveRequests < 3 && _logQueue.length) {
    const run = _logQueue.shift();
    run();
  }
}

function _downloadTaskLog(url, signal) {
  return new Promise((resolve,reject) => {
    const run = () => {
      if (signal.aborted) { reject(new DOMException('History read cancelled','AbortError')); return; }
      _logActiveRequests++;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(),30000);
      const abort = () => controller.abort();
      signal.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(() => fetch(url,{signal:controller.signal})).then(response => {
        if (response.ok === false) throw new Error(`日志请求失败（HTTP ${response.status}）`);
        return response.text();
      }).then(resolve,reject).finally(() => {
        clearTimeout(timeout);
        signal.removeEventListener('abort',abort);
        _logActiveRequests--;
        _drainLogQueue();
      });
    };
    _logQueue.push(run);
    _drainLogQueue();
  });
}

// Coalesce concurrent readers while letting each view cancel independently.
// The final consumer aborts both a queued request and its underlying download.
async function _fetchTaskLogCached(task, {signal} = {}) {
  const isFinished = task.status !== 'running' && task.status !== 'pending' && task.status !== 'scheduled';
  if (signal?.aborted) throw new DOMException('History read cancelled','AbortError');
  const key = `${isFinished ? 'finished' : 'raw'}:${task.id}`;
  let request = _logRequests.get(key);
  if (!request) {
    request = {controller:new AbortController(),consumers:new Set()};
    request.promise = (async () => {
      if (isFinished) {
        if (_finishedLogCache.has(task.id)) {
          const text = _finishedLogCache.get(task.id);
          _rememberTaskLog(task.id,text);
          return text;
        }
        const persisted = await logCacheGet(task.id);
        if (persisted !== null && _looksLikeCompleteTaskLog(persisted)) {
          _rememberTaskLog(task.id,persisted);
          return persisted;
        }
        if (persisted !== null) await logCacheDelete(task.id);
      }
      const logSuffix = isFinished ? '?light=1' : '';
      const text = await _downloadTaskLog(`/api/tasks/${encodeURIComponent(task.id)}/logs${logSuffix}`,request.controller.signal);
      if (isFinished && !request.controller.signal.aborted && _looksLikeCompleteTaskLog(text)) {
        _rememberTaskLog(task.id,text);
        logCacheSet(task.id,text);
      }
      return text;
    })().finally(() => {if (_logRequests.get(key) === request) _logRequests.delete(key);});
    _logRequests.set(key,request);
  }
  return new Promise((resolve,reject) => {
    const consumer = {};
    request.consumers.add(consumer);
    const finish = () => {request.consumers.delete(consumer);signal?.removeEventListener('abort',abort);};
    const abort = () => {
      finish();
      reject(new DOMException('History read cancelled','AbortError'));
      if (!request.consumers.size) {
        request.controller.abort();
        if (_logRequests.get(key) === request) _logRequests.delete(key);
      }
    };
    signal?.addEventListener('abort',abort,{once:true});
    request.promise.then(value => {finish();resolve(value);},error => {finish();reject(error);});
  });
}
