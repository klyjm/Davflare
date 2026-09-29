import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { TransferQueueProvider, useTransferQueue } from "../transferQueue";
import { enqueueJob, registerJobDispatcher } from "../jobs";
import type { TransferTask } from "../types";

// job 任务管线集成测试：dispatcher 注册 → 入队 → runJobTask 执行 →
// 进度/终态入队。job 与 upload/download 共用同一条队列与取消/重试机制。

let latest: TransferTask[] = [];
function Probe() {
  latest = useTransferQueue();
  return null;
}

function renderQueue() {
  render(
    <TransferQueueProvider>
      <Probe />
    </TransferQueueProvider>
  );
}

describe("传输队列 job 任务", () => {
  test("enqueueJob → 执行回报进度 → completed", async () => {
    renderQueue();
    await act(async () => {
      enqueueJob({
        name: "job-ok",
        unit: "count",
        run: async ({ report }) => {
          report(1, 2);
          report(2, 2);
        },
      });
    });
    await waitFor(() => expect(latest[0]?.status).toBe("completed"));
    expect(latest[0]).toMatchObject({
      name: "job-ok",
      unit: "count",
      loaded: 2,
      total: 2,
    });
  });

  test("job 失败 → failed + 错误信息（面板可重试）", async () => {
    renderQueue();
    await act(async () => {
      enqueueJob({
        name: "job-bad",
        run: async () => {
          throw new Error("boom-job");
        },
      });
    });
    await waitFor(() => expect(latest[0]?.status).toBe("failed"));
    expect(latest[0]?.error).toBe("boom-job");
  });

  test("未注册 dispatcher（Provider 未挂载）→ enqueueJob 抛错", () => {
    registerJobDispatcher(null);
    expect(() =>
      enqueueJob({ name: "x", run: async () => undefined })
    ).toThrow("Job queue is not ready");
  });
});
