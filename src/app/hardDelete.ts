import pLimit from "p-limit";
import { authFetch } from "./auth";
import { enqueueJob } from "./jobs";
import { collectTreeKeys } from "./transfer";
import { WEBDAV_ENDPOINT } from "./uploadTransfer";
import { translate } from "./strings";
import { encodeKey } from "./utils";

// 免费档 Pages Function 的软删除要在单次请求里把整个子树逐字节复制进回收站，
// 大文件夹必然撞 1102（Worker exceeded resource limits）。本桶另有 7 天对象
// lifecycle 兜底，回收站没有实际保留价值——删除改为客户端分批逐文件硬删：
// 每个请求只删一个对象（1 次内部子请求），任何大小都秒级完成。
// 进度并入传输面板（type === "job"，按项数报进度），不再用右下角浮层。

async function deleteOne(key: string): Promise<void> {
  const res = await authFetch(`${WEBDAV_ENDPOINT}${encodeKey(key)}`, {
    method: "DELETE",
  });
  // 404 = 已不存在（重复删除/竞态），视为成功
  if (!res.ok && res.status !== 404) {
    throw new Error(`HTTP ${res.status}: ${key}`);
  }
}

/** 把永久删除排入传输面板。展开树与逐对象 DELETE 都在 job 内执行：
 * 入队即返回（UI 提示“已开始删除”），失败进面板可重试（404 容忍，
 * 重试自动跳过已删对象）。 */
export function enqueuePermanentDelete(keys: string[]): void {
  enqueueJob({
    name: translate("deleteTaskName"),
    unit: "count",
    run: async ({ signal, report }) => {
      const { files, dirs } = await collectTreeKeys(keys);
      const total = files.length + dirs.length;
      report(0, total);
      const limit = pLimit(8);
      let done = 0;
      await Promise.all(
        files.map((key) =>
          limit(async () => {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            await deleteOne(key);
            done += 1;
            report(done, total);
          })
        )
      );
      // 目录标记按"子在前"顺序收尾（collectTreeKeys 已排好）
      for (const dir of dirs) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await deleteOne(dir);
        done += 1;
        report(done, total);
      }
    },
  });
}
