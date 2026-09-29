import pLimit from "p-limit";

// 目录形式下载（fork 补丁）：基于 File System Access API 把网盘条目按原目录
// 结构直接写盘，替代 zip。showDirectoryPicker 必须在点击的用户激活期内调用
// （浏览器硬约束），因此 pickTargetDirectory 由点击处理器同步调用，逐文件
// 拉流写盘则作为 job 在传输面板里执行、进度可见、可取消。不支持该 API 的
// 浏览器由调用方回退服务端 zip（小文件夹可用）。

export interface DiskEntry {
  key: string; // 网盘内完整键（目录占位条目不拉内容）
  relPath: string; // 相对下载根的路径；目录占位以 "/" 结尾
  size: number;
  uploaded?: string | Date | null;
  dir?: boolean; // 空目录占位
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
};

export function supportsDiskWrite(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function"
  );
}

/**
 * 弹目录选择器，返回所选目录句柄；用户取消返回 null（调用方静默放弃）。
 * 必须在点击的用户激活期内调用——先弹窗，展开/下载都放到之后的 job 里。
 */
export async function pickTargetDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    return await picker({ mode: "readwrite" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  }
}

async function ensureDirectory(
  parent: FileSystemDirectoryHandle,
  path: string
): Promise<FileSystemDirectoryHandle> {
  let dir = parent;
  for (const segment of path.split("/")) {
    if (!segment) continue;
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

async function openWritable(
  base: FileSystemDirectoryHandle,
  relPath: string
): Promise<FileSystemWritableFileStream> {
  const segments = relPath.split("/").filter(Boolean);
  const name = segments.pop();
  if (!name) throw new Error(`Invalid entry path: ${relPath}`);
  const dir = await ensureDirectory(base, segments.join("/"));
  return (await dir.getFileHandle(name, { create: true })).createWritable();
}

/**
 * 把条目按目录结构写入 root/subfolder。逐文件拉流写盘，p-limit(3) 并发；
 * report 按“文件字节”回报进度（loaded/total 为字节）。signal 取消时中止
 * 当前 writable（临时文件被丢弃）并抛 AbortError。
 */
export async function writeTreeToDirectory({
  root,
  subfolder,
  entries,
  fetchFile,
  signal,
  report,
}: {
  root: FileSystemDirectoryHandle;
  subfolder: string;
  entries: DiskEntry[];
  fetchFile: (key: string, signal?: AbortSignal) => Promise<Response>;
  signal?: AbortSignal;
  report: (loaded: number, total: number) => void;
}): Promise<void> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const base = subfolder
    ? await ensureDirectory(root, subfolder)
    : root;
  const total = entries.reduce(
    (sum, entry) => sum + (entry.dir ? 0 : Number(entry.size) || 0),
    0
  );
  let done = 0;
  report(0, total);

  const limit = pLimit(3);
  await Promise.all(
    entries.map((entry) =>
      limit(async () => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (entry.dir) {
          await ensureDirectory(base, entry.relPath.replace(/\/+$/, ""));
          return;
        }
        const writable = await openWritable(base, entry.relPath);
        try {
          const res = await fetchFile(entry.key, signal);
          if (!res.ok || !res.body) {
            throw new Error(`HTTP ${res.status}: ${entry.relPath}`);
          }
          // 目录占位对象被误当文件时（探测遗漏的兜底）：补建目录，不产 0 字节假文件。
          if (
            (res.headers.get("Content-Type") || "").includes(
              "application/x-directory"
            )
          ) {
            await writable.abort().catch(() => undefined);
            await ensureDirectory(base, entry.relPath.replace(/\/+$/, ""));
            return;
          }
          const reader = res.body.getReader();
          for (;;) {
            const { done: streamDone, value } = await reader.read();
            if (streamDone) break;
            if (!value) continue;
            await writable.write(value);
            done += value.byteLength;
            report(done, total);
          }
          await writable.close();
        } catch (error) {
          await writable.abort(error).catch(() => undefined);
          throw error;
        }
      })
    )
  );
}
