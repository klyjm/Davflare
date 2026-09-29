import type { JobSpec } from "./types";

// job 入队桥（与 transfer.ts 的 downloadDispatcher 同模式）：TransferQueueProvider
// 挂载后注册 enqueueJob 实现，把自定义任务（删除、目录下载）并进传输面板。
// 注册前调用抛错——job 没有 legacy 直连路径，失败要可见就得进面板。
let jobDispatcher: ((spec: JobSpec) => void) | null = null;

export function registerJobDispatcher(
  dispatcher: ((spec: JobSpec) => void) | null
) {
  jobDispatcher = dispatcher;
}

export function enqueueJob(spec: JobSpec): void {
  if (!jobDispatcher) {
    throw new Error("Job queue is not ready");
  }
  jobDispatcher(spec);
}
