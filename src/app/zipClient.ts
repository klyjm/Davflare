import { Zip, ZipPassThrough } from "fflate";

// 浏览器端流式打包（fork 补丁）。服务端 /api/archive 在免费档 Pages Function 里
// 打包大文件夹会撞 CPU（10ms，zip 每字节要 CRC32）与内存（128MB：构建循环不
// 感知背压，R2 数据积压在 isolate 里直到被强杀）两根硬线，表现为 zip 截断或 0B。
// 这里改为：先弹"另存为"拿磁盘句柄（必须在点击的用户激活期内），再逐文件拉
// /webdav 直通流写进本地 zip——内存恒定，大小不限。不支持 File System Access
// API 的浏览器由调用方回退旧的服务端打包。

export interface ZipEntry {
  key: string; // 网盘内完整键（目录占位条目不拉内容）
  relPath: string; // zip 内路径
  size: number;
  uploaded?: string | Date | null;
  dir?: boolean; // 空目录占位
}

/** 与 functions/api/_zip.ts 保持同一 zip 布局（Unix made-by + 0x5455 扩展时间戳）。 */
const ZIP_OS_UNIX = 3;
const ZIP_FILE_ATTRS = (0o100644 << 16) >>> 0;
const ZIP_DIR_ATTRS = ((0o040755 << 16) | 0x10) >>> 0;
const ZIP_EXTRA_EXT_TIMESTAMP = 0x5455;

function extendedTimestampExtra(mtime: Date): Uint8Array {
  const data = new Uint8Array(5);
  data[0] = 0x01;
  new DataView(data.buffer).setUint32(1, Math.floor(mtime.getTime() / 1000) >>> 0, true);
  return data;
}

/** DOS 时间只能表示 1981–2098（与 functions/api/_zip.ts 一致）；越界回退当前时间。 */
function entryTime(value: Date | string | number | undefined | null): Date {
  const date = value == null ? new Date() : new Date(value);
  const year = date.getUTCFullYear();
  if (Number.isNaN(date.getTime()) || year < 1981 || year > 2098) return new Date();
  return date;
}

function createZipEntry(name: string, mtime?: Date | string | number | null): ZipPassThrough {
  const entry = new ZipPassThrough(name);
  const time = entryTime(mtime);
  entry.os = ZIP_OS_UNIX;
  entry.attrs = name.endsWith("/") ? ZIP_DIR_ATTRS : ZIP_FILE_ATTRS;
  entry.mtime = time;
  entry.extra = { [ZIP_EXTRA_EXT_TIMESTAMP]: extendedTimestampExtra(time) };
  return entry;
}

interface DiskWritable {
  write: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort: (reason?: unknown) => Promise<void>;
}

interface PickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<{ createWritable: () => Promise<DiskWritable> }>;
}

export function supportsDiskZip(): boolean {
  return typeof (window as PickerWindow).showSaveFilePicker === "function";
}

let overlay: HTMLDivElement | null = null;

function showProgress(): (done: number, total: number) => void {
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
      "background:rgba(20,20,20,.85);color:#fff;padding:10px 14px;border-radius:8px;" +
      "font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3)";
    document.body.appendChild(overlay);
  }
  const fmt = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  return (done, total) => {
    if (!overlay) return;
    const pct = total > 0 ? `（${Math.min(100, Math.round((done / total) * 100))}%）` : "";
    overlay.textContent = `打包下载中：${fmt(done)} / ${fmt(total)}${pct}`;
  };
}

function hideProgress() {
  overlay?.remove();
  overlay = null;
}

/**
 * 把条目打包为 zip 写到本地磁盘。`expand` 在拿到另存为句柄后才执行（列出文件
 * 可能较慢，不能抢在用户激活期内）；中途任一文件失败会 abort 掉半成品文件。
 */
export async function saveEntriesAsZip(
  zipName: string,
  expand: () => Promise<ZipEntry[]>,
  fetchFile: (key: string) => Promise<Response>
): Promise<void> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (!picker) throw new Error("File System Access API unavailable");

  const fileHandle = await picker({
    suggestedName: zipName,
    types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }],
  });
  const writable = await fileHandle.createWritable();
  const setProgress = showProgress();

  // fflate 的回调是同步的：把磁盘写暂存起来，攒一批后串行落盘，内存有界。
  const pending: Promise<unknown>[] = [];
  const drain = () =>
    pending.length ? Promise.all(pending.splice(0)) : Promise.resolve();
  const zip = new Zip((error, data) => {
    if (error) throw error;
    if (data && data.length > 0) pending.push(writable.write(data));
  });

  try {
    const entries = await expand();
    const totalBytes = entries.reduce(
      (sum, e) => sum + (e.dir ? 0 : Number(e.size) || 0),
      0
    );
    let doneBytes = 0;

    for (const entry of entries) {
      const z = createZipEntry(entry.relPath, entry.uploaded ?? undefined);
      zip.add(z);
      if (entry.dir) {
        z.push(new Uint8Array(0), true);
        continue;
      }
      const res = await fetchFile(entry.key);
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}: ${entry.relPath}`);
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        z.push(value, false);
        doneBytes += value.byteLength;
        setProgress(doneBytes, totalBytes);
        if (pending.length >= 16) await drain();
      }
      z.push(new Uint8Array(0), true);
      await drain();
    }
    zip.end();
    await drain();
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  } finally {
    hideProgress();
  }
}
