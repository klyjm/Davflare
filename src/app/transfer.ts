import { authFetch } from "./auth";
import { DownloadRequest, FileItem } from "./types";
import { basename, encodeKey } from "./utils";
import { translate } from "./strings";
import { enqueueJob } from "./jobs";
import {
  pickTargetDirectory,
  supportsDiskWrite,
  writeTreeToDirectory,
  type DiskEntry,
} from "./diskDownload";

import { WEBDAV_ENDPOINT } from "./uploadTransfer";

// 下载入队桥：TransferQueueProvider 挂载后注册 enqueueDownload 实现。
// 注册前（单测/极端兜底）download* 函数退回直连下载，行为与旧版一致。
let downloadDispatcher: ((request: DownloadRequest) => void) | null = null;

export function registerDownloadDispatcher(
  dispatcher: ((request: DownloadRequest) => void) | null
) {
  downloadDispatcher = dispatcher;
}

function enqueueOrRun(request: DownloadRequest, legacy: () => Promise<void>) {
  if (downloadDispatcher) {
    downloadDispatcher(request);
    return;
  }
  return legacy();
}

function decodeHrefSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Object key from a PROPFIND href, whether relative (`/webdav/a/b`) or absolute. */
export function davHrefToKey(href: string): string {
  const raw = (href || "").trim();
  if (!raw) return "";

  let pathname = raw;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      pathname = new URL(raw).pathname;
    }
  } catch {
    const fallback = raw.indexOf("/webdav/");
    if (fallback >= 0) pathname = raw.slice(fallback);
  }

  const marker = "/webdav/";
  const at = pathname.indexOf(marker);
  let rest: string;
  if (at >= 0) {
    rest = pathname.slice(at + marker.length);
  } else if (pathname === "/webdav") {
    rest = "";
  } else if (pathname.startsWith("/")) {
    rest = pathname.slice(1);
  } else {
    rest = pathname;
  }

  return rest.split("/").map(decodeHrefSegment).join("/").replace(/\/$/, "");
}

function firstTag(parent: Element, localName: string): Element | undefined {
  return parent.getElementsByTagName(localName)[0];
}

export async function fetchPath(path: string) {
  const res = await authFetch(`${WEBDAV_ENDPOINT}${encodeKey(path)}`, {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });

  if (!res.ok) throw new Error("Failed to fetch");
  if (!res.headers.get("Content-Type")?.includes("application/xml"))
    throw new Error("Invalid response");

  const parser = new DOMParser();
  const text = await res.text();
  const document = parser.parseFromString(text, "application/xml");
  const cwdKey = path.replace(/\/$/, "");
  const items: FileItem[] = [];

  for (const response of Array.from(document.getElementsByTagName("response"))) {
    const href = firstTag(response, "href")?.textContent ?? "";
    const key = davHrefToKey(href);
    if (!href) continue;
    if (key === cwdKey) continue;

    const contentType = firstTag(response, "getcontenttype")?.textContent || "";
    const size = firstTag(response, "getcontentlength")?.textContent;
    const lastModified = firstTag(response, "getlastmodified")?.textContent;
    const thumbnail =
      response.getElementsByTagNameNS("flaredrive", "thumbnail")[0]
        ?.textContent || undefined;
    const resourceType = firstTag(response, "resourcetype");
    const isDir =
      contentType === "application/x-directory" ||
      Boolean(resourceType?.getElementsByTagName("collection").length);

    items.push({
      key,
      name: basename(key),
      isDir,
      size: size ? Number(size) : 0,
      uploaded: lastModified || new Date().toUTCString(),
      contentType: contentType || (isDir ? "application/x-directory" : ""),
      thumbnail: thumbnail || undefined,
    });
  }
  return items;
}

export interface SearchResponse {
  items: FileItem[];
  hasMore: boolean;
  nextCursor?: string;
}

// 批量统计文件夹的直接子项数（惰性计数）：单次 POST /api/counts 拿回全部，
// 失败整体返回空（调用方保留占位文案）
export async function fetchFolderCounts(
  keys: string[]
): Promise<Record<string, number>> {
  if (!keys.length) return {};
  try {
    const res = await authFetch("/api/counts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: keys.slice(0, 100) }),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as { counts?: Record<string, number> };
    return data.counts ?? {};
  } catch {
    return {};
  }
}

export async function searchFiles(
  query: string,
  cursor?: string,
  limit = 100
): Promise<SearchResponse> {
  const params: Record<string, string> = { q: query, limit: String(limit) };
  if (cursor) params.cursor = cursor;
  const res = await authFetch(`/api/search?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error("Search failed");
  const data = (await res.json()) as {
    items: Array<Record<string, any>>;
    hasMore: boolean;
    nextCursor?: string;
  };
  return {
    items: data.items.map((item) => ({
      key: item.key,
      name: basename(item.key),
      isDir: item.contentType === "application/x-directory",
      size: item.size,
      uploaded: item.uploaded,
      contentType: item.contentType || "",
      thumbnail: item.thumbnail || undefined,
    })),
    hasMore: data.hasMore,
    nextCursor: data.nextCursor,
  };
}

export async function openFile(key: string) {
  const res = await authFetch(`${WEBDAV_ENDPOINT}${encodeKey(key)}`);
  if (!res.ok) throw new Error(translate("openFileFailed"));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadFile(key: string) {
  const name = basename(key) || "download";
  return enqueueOrRun(
    { name, downloadUrl: `${WEBDAV_ENDPOINT}${encodeKey(key)}` },
    () => legacyDownloadFile(key, name)
  );
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 未注册队列时的直连下载（与入队后的 processDownloadTask 保存逻辑一致）。 */
async function legacyDownloadFile(key: string, name: string) {
  const res = await authFetch(`${WEBDAV_ENDPOINT}${encodeKey(key)}`);
  if (!res.ok) throw new Error(translate("downloadFailed"));
  saveBlob(await res.blob(), name);
}

/** zip 下载名：`<文件夹名>.zip`，网盘根（空键）为 `archive.zip`；与 GET /api/archive 命名一致。 */
export function archiveNameFor(folderKey: string): string {
  const name = basename(folderKey);
  return name ? `${name}.zip` : "archive.zip";
}

// ---------- 目录形式下载（fork 补丁）----------
// 免费档 Pages Function 服务端打包大文件夹会因 CPU/内存上限断流（截断 zip/0B），
// 见 src/app/diskDownload.ts 头注。支持 File System Access API 的浏览器把条目
// 按原目录结构直接写盘（非 zip）；其余回退旧的服务端 /api/archive（小文件夹仍可用）。

function fetchDriveFile(key: string, signal?: AbortSignal) {
  return authFetch(`${WEBDAV_ENDPOINT}${encodeKey(key)}`, { signal });
}

// HEAD 拿单键元数据。只用 webdav 会话端点——/api/stat 只认 API Key，
// 网页会话调它会 401 并触发 authFetch 清凭据弹登录框（踩过的坑）。
async function headMeta(
  key: string
): Promise<{ ok: boolean; isDir: boolean; size: number; uploaded: string | null }> {
  try {
    const res = await authFetch(`${WEBDAV_ENDPOINT}${encodeKey(key)}`, {
      method: "HEAD",
    });
    const contentType = res.headers.get("Content-Type") || "";
    return {
      ok: res.ok,
      isDir: contentType.includes("application/x-directory"),
      size: Number(res.headers.get("Content-Length")) || 0,
      uploaded: res.headers.get("Last-Modified"),
    };
  } catch {
    return { ok: false, isDir: false, size: 0, uploaded: null };
  }
}

/** 展开选中键为写盘条目：文件直接收，目录递归 PROPFIND；空目录写占位条目。 */
async function expandDiskEntries(
  keys: string[],
  stripPrefix: string
): Promise<DiskEntry[]> {
  const base = stripPrefix.replace(/\/+$/, "");
  const rel = (key: string) =>
    base && key.startsWith(`${base}/`) ? key.slice(base.length + 1) : key;
  const entries: DiskEntry[] = [];
  const seenDirs = new Set<string>();

  const walkDir = async (dirKey: string): Promise<void> => {
    if (seenDirs.has(dirKey)) return;
    seenDirs.add(dirKey);
    const items = await fetchPath(`${dirKey}/`);
    if (items.length === 0) {
      entries.push({ key: dirKey, relPath: `${rel(dirKey)}/`, size: 0, dir: true });
      return;
    }
    for (const item of items) {
      if (item.key.startsWith("_$flaredrive$/")) continue;
      if (item.isDir) await walkDir(item.key);
      else {
        entries.push({
          key: item.key,
          relPath: rel(item.key),
          size: item.size,
          uploaded: item.uploaded,
        });
      }
    }
  };

  for (const rawKey of keys) {
    const key = rawKey.replace(/\/+$/, "");
    if (!key || seenDirs.has(key)) continue;
    // 目录判定只用 PROPFIND（有子项）或 HEAD 的 x-directory 标记，
    // 不打 /api/*：那些端点多为 API-Key 专用。
    let items: FileItem[] = [];
    try {
      items = await fetchPath(`${key}/`);
    } catch {
      items = [];
    }
    if (items.length > 0) {
      await walkDir(key);
      continue;
    }
    const meta = await headMeta(key);
    if (meta.isDir) {
      // 选中根自身（单文件夹下载且为空）不写占位条目——writeTreeToDirectory
      // 已按 subfolder 建根目录，占位会造成 EMPTY/EMPTY/ 双层
      if (key !== base) {
        entries.push({ key, relPath: `${rel(key)}/`, size: 0, dir: true });
      }
    } else if (meta.ok) {
      // 键在展开期间被删（headMeta 不 ok）时跳过，避免产生必 404 的幽灵文件
      entries.push({
        key,
        relPath: rel(key),
        size: meta.size,
        uploaded: meta.uploaded,
      });
    }
  }
  return entries;
}

/**
 * 展开选中键为完整键清单（删除等批量操作用）：files 为全部文件键，
 * dirs 为全部目录标记键（含选中目录自身），返回时已按"子目录在前"排序。
 */
export async function collectTreeKeys(
  keys: string[]
): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  const seen = new Set<string>();

  const walkDir = async (dirKey: string): Promise<void> => {
    if (seen.has(dirKey)) return;
    seen.add(dirKey);
    dirs.push(dirKey);
    const items = await fetchPath(`${dirKey}/`);
    for (const item of items) {
      if (item.key.startsWith("_$flaredrive$/")) continue;
      if (item.isDir) await walkDir(item.key);
      else files.push(item.key);
    }
  };

  for (const rawKey of keys) {
    const key = rawKey.replace(/\/+$/, "");
    if (!key || seen.has(key)) continue;
    let items: FileItem[] = [];
    try {
      items = await fetchPath(`${key}/`);
    } catch {
      items = [];
    }
    if (items.length > 0) {
      await walkDir(key);
      continue;
    }
    const meta = await headMeta(key);
    if (meta.isDir) await walkDir(key);
    else if (meta.ok) files.push(key);
  }
  return { files, dirs: dirs.reverse() };
}

/** 把“展开条目 + 按目录结构写盘”排入传输面板（type === "job"，按字节报进度）。 */
function enqueueTreeDownload({
  root,
  subfolder,
  expand,
  name,
}: {
  root: FileSystemDirectoryHandle;
  subfolder: string;
  expand: () => Promise<DiskEntry[]>;
  name: string;
}) {
  enqueueJob({
    name,
    unit: "bytes",
    run: async ({ signal, report }) => {
      const entries = await expand();
      await writeTreeToDirectory({
        root,
        subfolder,
        entries,
        fetchFile: fetchDriveFile,
        signal,
        report,
      });
    },
  });
}

/**
 * POST /api/archive 多选打包。`base`（选中项所在文件夹）会把条目路径改为相对该文件夹；
 * 不传则条目为完整网盘路径（旧行为）。有磁盘句柄 API 时改为目录形式写盘。
 */
export async function downloadArchive(keys: string[], name = "archive.zip", base?: string) {
  if (supportsDiskWrite()) {
    // 目录选择器必须在点击的用户激活期内弹出：先弹窗（取消即放弃），
    // 展开与写盘都放到之后的 job 里执行。
    const dir = await pickTargetDirectory();
    if (dir) {
      const baseKey = (base || "").replace(/\/+$/, "");
      enqueueTreeDownload({
        root: dir,
        subfolder: basename(baseKey),
        expand: () => expandDiskEntries(keys, baseKey),
        name: name.replace(/\.zip$/, ""),
      });
    }
    return;
  }
  return enqueueOrRun(
    {
      name,
      downloadUrl: "/api/archive",
      init: {
        method: "POST",
        body: JSON.stringify(base ? { keys, base } : { keys }),
      },
    },
    () => legacyDownloadArchive(keys, name, base)
  );
}

async function legacyDownloadArchive(keys: string[], name: string, base?: string) {
  const res = await authFetch("/api/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(base ? { keys, base } : { keys }),
  });
  if (!res.ok) throw new Error((await res.text()) || translate("archiveFailed"));
  saveBlob(await res.blob(), name);
}

/** 单个文件夹下载：有磁盘句柄 API 时以目录形式写入所选文件夹（非 zip）；
 * 否则回退与 `GET /api/archive?path=` 一致的服务端 zip。 */
export async function downloadFolderArchive(folderKey: string) {
  const key = folderKey.replace(/\/+$/, "");
  if (supportsDiskWrite()) {
    // 同 downloadArchive：先弹目录选择器（用户激活期内），再入队写盘。
    const dir = await pickTargetDirectory();
    if (dir) {
      enqueueTreeDownload({
        root: dir,
        subfolder: basename(key),
        expand: () => expandDiskEntries([key], key),
        name: basename(key) || "archive",
      });
    }
    return;
  }
  return enqueueOrRun(
    {
      name: archiveNameFor(key),
      downloadUrl: `/api/archive?path=${encodeURIComponent(`${key}/`)}`,
    },
    () => legacyDownloadFolderArchive(key)
  );
}

async function legacyDownloadFolderArchive(key: string) {
  const res = await authFetch(`/api/archive?path=${encodeURIComponent(`${key}/`)}`);
  if (!res.ok) throw new Error((await res.text()) || translate("archiveFailed"));
  saveBlob(await res.blob(), archiveNameFor(key));
}

/**
 * 多选下载：选中全在当前文件夹 `cwd` 下时，zip 名为 `<cwd 名>.zip`（根目录为 archive.zip），
 * 条目相对 `cwd`；跨文件夹（如全局搜索结果）时退回完整路径 + archive.zip。
 */
export async function downloadSelectionArchive(keys: string[], cwd: string) {
  const base = cwd && keys.every((key) => key.startsWith(cwd)) ? cwd : "";
  return downloadArchive(keys, archiveNameFor(base), base || undefined);
}

export async function copyPaste(source: string, target: string, move = false) {
  const uploadUrl = `${WEBDAV_ENDPOINT}${encodeKey(source)}`;
  const destinationUrl = new URL(
    `${WEBDAV_ENDPOINT}${encodeKey(target)}`,
    window.location.href
  );
  const response = await authFetch(uploadUrl, {
    method: move ? "MOVE" : "COPY",
    headers: { Destination: destinationUrl.href },
  });
  if (!response.ok) {
    throw new Error(move ? translate("moveFailed") : translate("copyFailed2"));
  }
}

export async function createFolder(cwd: string, folderName: string) {
  const name = folderName.trim();
  if (!name) throw new Error(translate("folderNameRequired"));
  if (name.includes("/")) throw new Error(translate("folderNameNoSlash"));
  const folderKey = `${cwd}${name}`;
  const uploadUrl = `${WEBDAV_ENDPOINT}${encodeKey(folderKey)}`;
  const response = await authFetch(uploadUrl, { method: "MKCOL" });
  if (!response.ok) throw new Error(translate("createFolderFailed"));
}


export * from "./uploadTransfer";
