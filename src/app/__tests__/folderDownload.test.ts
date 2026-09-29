import { vi, type Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { downloadArchive, downloadFolderArchive } from "../transfer";
import { registerJobDispatcher } from "../jobs";
import { pickTargetDirectory, writeTreeToDirectory } from "../diskDownload";
import { authFetch } from "../auth";
import type { JobSpec } from "../types";

// 目录形式下载集成测试（fork 补丁）：mock 磁盘写盘与鉴权 fetch，
// 走真实的 downloadArchive/downloadFolderArchive → enqueueJob 桥 →
// expandDiskEntries（解析真实 PROPFIND XML）→ writeTreeToDirectory 参数断言。

vi.mock("../auth", () => ({
  authFetch: vi.fn(),
  basicAuthHeader: vi.fn(() => ""),
}));

vi.mock("../diskDownload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pickTargetDirectory: vi.fn(),
  writeTreeToDirectory: vi.fn(),
}));

const mockAuthFetch = authFetch as unknown as Mock;
const mockPick = pickTargetDirectory as unknown as Mock;
const mockWrite = writeTreeToDirectory as unknown as Mock;

const fakeRoot = { kind: "directory" } as FileSystemDirectoryHandle;

function multistatus(entries: string[]): Response {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
${entries.join("\n")}
</multistatus>`;
  return {
    ok: true,
    status: 207,
    headers: { get: () => "application/xml; charset=utf-8" },
    text: async () => xml,
  } as unknown as Response;
}

function propEntry(href: string, prop: string): string {
  return `  <response>
    <href>${href}</href>
    <propstat><prop>${prop}</prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>`;
}

const fileProps = (size: number) =>
  `<getcontentlength>${size}</getcontentlength><getcontenttype>text/plain</getcontenttype>`;
const dirProps = `<resourcetype><collection/></resourcetype>`;

function fileRes(ok: boolean, status: number, contentType: string) {
  return {
    ok,
    status,
    headers: {
      get: (name: string) =>
        name === "Content-Type"
          ? contentType
          : name === "Content-Length"
            ? "7"
            : null,
    },
  } as unknown as Response;
}

// 先注册捕获器再调用下载入口；盒子模式避免 TS 对闭包赋值的收窄
function captureJob(): { current: JobSpec | null } {
  const box: { current: JobSpec | null } = { current: null };
  registerJobDispatcher((spec) => {
    box.current = spec;
  });
  return box;
}

describe("目录形式下载（transfer 磁盘路径）", () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
    mockPick.mockReset();
    mockWrite.mockReset();
    mockWrite.mockResolvedValue(undefined);
    // 真实 supportsDiskWrite 需要 window 上有 showDirectoryPicker
    (window as unknown as Record<string, unknown>).showDirectoryPicker = vi.fn();
  });

  afterEach(() => {
    registerJobDispatcher(null);
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });

  test("单文件夹下载：递归展开 + 相对路径 + 跳过 _$flaredrive$", async () => {
    mockAuthFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "PROPFIND" && url === "/webdav/RA2/") {
        return multistatus([
          propEntry("/webdav/RA2/", dirProps),
          propEntry("/webdav/RA2/b.txt", fileProps(3)),
          propEntry("/webdav/RA2/sub/", dirProps),
          propEntry("/webdav/_$flaredrive$/trash/x", fileProps(9)),
        ]);
      }
      if (method === "PROPFIND" && url === "/webdav/RA2/sub/") {
        return multistatus([
          propEntry("/webdav/RA2/sub/", dirProps),
          propEntry("/webdav/RA2/sub/c.bin", fileProps(5)),
        ]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    mockPick.mockResolvedValue(fakeRoot);
    const box = captureJob();
    await downloadFolderArchive("RA2");
    const spec = box.current!;
    expect(spec.name).toBe("RA2");
    expect(spec.unit).toBe("bytes");

    // 让写盘 mock 模拟真实 report 行为，验证 job 把 report 透传进面板
    mockWrite.mockImplementation(async (args: { report: (l: number, t: number) => void }) => {
      args.report(0, 8);
    });
    const reports: Array<[number, number]> = [];
    await spec.run({ report: (l, t) => reports.push([l, t]), signal: undefined });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const args = mockWrite.mock.calls[0][0];
    expect(args.root).toBe(fakeRoot);
    expect(args.subfolder).toBe("RA2");
    expect(args.entries).toEqual([
      { key: "RA2/b.txt", relPath: "b.txt", size: 3, uploaded: expect.any(String) },
      { key: "RA2/sub/c.bin", relPath: "sub/c.bin", size: 5, uploaded: expect.any(String) },
    ]);
    expect(reports[0]).toEqual([0, 8]);
  });

  test("空文件夹下载：不产生根占位条目（避免双层目录）", async () => {
    mockAuthFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? "") === "PROPFIND" && url === "/webdav/EMPTY/") {
        return multistatus([propEntry("/webdav/EMPTY/", dirProps)]);
      }
      if (url === "/webdav/EMPTY") {
        return fileRes(true, 200, "application/x-directory");
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
    mockPick.mockResolvedValue(fakeRoot);
    const box = captureJob();
    await downloadFolderArchive("EMPTY");
    await box.current!.run({ report: vi.fn(), signal: undefined });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ subfolder: "EMPTY", entries: [] })
    );
  });

  test("嵌套空目录：walkDir 写子目录占位", async () => {
    mockAuthFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? "") === "PROPFIND" && url === "/webdav/PARENT/") {
        return multistatus([
          propEntry("/webdav/PARENT/", dirProps),
          propEntry("/webdav/PARENT/void/", dirProps),
        ]);
      }
      if ((init?.method ?? "") === "PROPFIND" && url === "/webdav/PARENT/void/") {
        return multistatus([propEntry("/webdav/PARENT/void/", dirProps)]);
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
    mockPick.mockResolvedValue(fakeRoot);
    const box = captureJob();
    await downloadFolderArchive("PARENT");
    await box.current!.run({ report: vi.fn(), signal: undefined });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [{ key: "PARENT/void", relPath: "void/", size: 0, dir: true }],
      })
    );
  });

  test("多选下载：base 相对化 + 任务名去掉 .zip", async () => {
    mockAuthFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? "") === "PROPFIND" && url === "/webdav/RA2/a.txt/") {
        return multistatus([propEntry("/webdav/RA2/a.txt/", dirProps)]);
      }
      if (url === "/webdav/RA2/a.txt") {
        return fileRes(true, 200, "text/plain");
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
    mockPick.mockResolvedValue(fakeRoot);
    const box = captureJob();
    await downloadArchive(["RA2/a.txt"], "RA2.zip", "RA2");
    const spec = box.current!;
    expect(spec.name).toBe("RA2");
    await spec.run({ report: vi.fn(), signal: undefined });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        subfolder: "RA2",
        entries: [
          { key: "RA2/a.txt", relPath: "a.txt", size: 7, uploaded: null },
        ],
      })
    );
  });

  test("PROPFIND 失败 → HEAD 兜底：文件收进条目、目录写占位", async () => {
    mockAuthFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "PROPFIND") {
        return { ok: false, status: 500 } as unknown as Response;
      }
      if (method === "HEAD" && url === "/webdav/solo.txt") {
        return fileRes(true, 200, "text/plain");
      }
      if (method === "HEAD" && url === "/webdav/RA2/nested") {
        return fileRes(true, 200, "application/x-directory");
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    mockPick.mockResolvedValue(fakeRoot);
    const box = captureJob();
    await downloadArchive(["solo.txt", "RA2/nested"], "archive.zip", "");
    await box.current!.run({ report: vi.fn(), signal: undefined });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        subfolder: "",
        entries: [
          { key: "solo.txt", relPath: "solo.txt", size: 7, uploaded: null },
          { key: "RA2/nested", relPath: "RA2/nested/", size: 0, dir: true },
        ],
      })
    );
  });

  test("幽灵键（HEAD 也不存在）→ 跳过不产假条目", async () => {
    mockAuthFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "PROPFIND") {
        return { ok: false, status: 404 } as unknown as Response;
      }
      if (method === "HEAD" && url === "/webdav/gone.txt") {
        return fileRes(false, 404, "");
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    mockPick.mockResolvedValue(fakeRoot);
    const box = captureJob();
    await downloadArchive(["gone.txt"], "archive.zip", "");
    await box.current!.run({ report: vi.fn(), signal: undefined });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [] })
    );
  });

  test("用户取消目录选择 → 不入队", async () => {
    mockPick.mockResolvedValue(null);
    let dispatched = 0;
    registerJobDispatcher(() => {
      dispatched += 1;
    });
    await downloadFolderArchive("RA2");
    expect(dispatched).toBe(0);
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
