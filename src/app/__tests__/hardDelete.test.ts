import { vi, type Mock } from "vitest";
import { beforeEach, describe, expect, test } from "vitest";

import { enqueuePermanentDelete } from "../hardDelete";
import { registerJobDispatcher } from "../jobs";
import { collectTreeKeys } from "../transfer";
import { authFetch } from "../auth";
import type { JobSpec } from "../types";

vi.mock("../transfer", () => ({
  collectTreeKeys: vi.fn(),
}));
vi.mock("../auth", () => ({
  authFetch: vi.fn(),
}));

const mockCollect = collectTreeKeys as unknown as Mock;
const mockAuthFetch = authFetch as unknown as Mock;

function captureJob(): JobSpec {
  let captured: JobSpec | null = null;
  registerJobDispatcher((spec) => {
    captured = spec;
  });
  enqueuePermanentDelete(["x"]);
  if (!captured) throw new Error("dispatcher not registered");
  return captured;
}

function res(status: number) {
  return { ok: status >= 200 && status < 300, status };
}

describe("enqueuePermanentDelete", () => {
  beforeEach(() => {
    mockCollect.mockReset();
    mockAuthFetch.mockReset();
  });

  test("展开树 → 逐对象 DELETE → 按项数回报进度", async () => {
    mockCollect.mockResolvedValue({ files: ["f1", "f2"], dirs: ["d1"] });
    mockAuthFetch.mockResolvedValue(res(200));
    const spec = captureJob();
    const reports: Array<[number, number]> = [];
    await spec.run({
      report: (loaded, total) => reports.push([loaded, total]),
      signal: undefined,
    });
    expect(mockAuthFetch).toHaveBeenCalledTimes(3);
    expect(reports[0]).toEqual([0, 3]);
    expect(reports.at(-1)).toEqual([3, 3]);
    // 面板按“n / m 项”显示
    expect(spec.unit).toBe("count");
  });

  test("404 容忍（重复删除/竞态视为成功）", async () => {
    mockCollect.mockResolvedValue({ files: ["f1"], dirs: [] });
    mockAuthFetch.mockResolvedValue(res(404));
    const spec = captureJob();
    await expect(
      spec.run({ report: vi.fn(), signal: undefined })
    ).resolves.toBeUndefined();
  });

  test("非 404 失败 → job 拒绝（面板可重试）", async () => {
    mockCollect.mockResolvedValue({ files: ["f1"], dirs: [] });
    mockAuthFetch.mockResolvedValue(res(500));
    const spec = captureJob();
    await expect(
      spec.run({ report: vi.fn(), signal: undefined })
    ).rejects.toThrow("HTTP 500: f1");
  });

  test("signal 已中止 → 抛 AbortError，不发请求", async () => {
    mockCollect.mockResolvedValue({ files: ["f1"], dirs: [] });
    const spec = captureJob();
    const controller = new AbortController();
    controller.abort();
    await expect(
      spec.run({ report: vi.fn(), signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });
});
