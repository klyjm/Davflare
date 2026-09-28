import pLimit from "p-limit";
import { authFetch } from "./auth";
import { showProgressOverlay, hideProgressOverlay } from "./zipClient";
import { collectTreeKeys } from "./transfer";
import { WEBDAV_ENDPOINT } from "./uploadTransfer";
import { encodeKey } from "./utils";

// 免费档 Pages Function 的软删除要在单次请求里把整个子树逐字节复制进回收站，
// 大文件夹必然撞 1102（Worker exceeded resource limits）。本桶另有 7 天对象
// lifecycle 兜底，回收站没有实际保留价值——删除改为客户端分批逐文件硬删：
// 每个请求只删一个对象（1 次内部子请求），任何大小都秒级完成。

async function deleteOne(key: string): Promise<void> {
  const res = await authFetch(`${WEBDAV_ENDPOINT}${encodeKey(key)}`, {
    method: "DELETE",
  });
  // 404 = 已不存在（重复删除/竞态），视为成功
  if (!res.ok && res.status !== 404) {
    throw new Error(`HTTP ${res.status}: ${key}`);
  }
}

/** 永久删除选中项（文件或目录树），返回删除的对象总数。 */
export async function deleteTreePermanently(keys: string[]): Promise<number> {
  const { files, dirs } = await collectTreeKeys(keys);
  const total = files.length + dirs.length;
  const setProgress = showProgressOverlay("删除中");
  let done = 0;
  try {
    const limit = pLimit(8);
    await Promise.all(
      files.map((key) =>
        limit(async () => {
          await deleteOne(key);
          done += 1;
          setProgress(done, total);
        })
      )
    );
    // 目录标记按"子在前"顺序收尾（collectTreeKeys 已排好）
    for (const dir of dirs) {
      await deleteOne(dir);
      done += 1;
      setProgress(done, total);
    }
  } finally {
    hideProgressOverlay();
  }
  return total;
}
