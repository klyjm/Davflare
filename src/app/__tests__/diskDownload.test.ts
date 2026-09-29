import { afterEach, describe, expect, test, vi, type Mock } from "vitest";

import {
  pickTargetDirectory,
  supportsDiskWrite,
  writeTreeToDirectory,
  type DiskEntry,
} from "../diskDownload";

// Fake FS Access 句柄：只实现 writeTreeToDirectory 用到的面
// （getDirectoryHandle/getFileHandle/createWritable + write/close/abort）。

class FakeWritable {
  written: Uint8Array[] = [];
  closed = false;
  aborted = false;
  async write(data: Uint8Array) {
    if (this.aborted) throw new Error("write after abort");
    this.written.push(data);
  }
  async close() {
    this.closed = true;
  }
  async abort() {
    this.aborted = true;
  }
  get byteLength() {
    return this.written.reduce((sum, chunk) => sum + chunk.length, 0);
  }
}

class FakeFileHandle {
  writable = new FakeWritable();
  createWritable() {
    return Promise.resolve(this.writable);
  }
}

class FakeDirHandle {
  dirs = new Map<string, FakeDirHandle>();
  files = new Map<string, FakeFileHandle>();
  getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let dir = this.dirs.get(name);
    if (!dir && options?.create) {
      dir = new FakeDirHandle();
      this.dirs.set(name, dir);
    }
    if (!dir) return Promise.reject(new Error(`no dir: ${name}`));
    return Promise.resolve(dir);
  }
  getFileHandle(name: string, options?: { create?: boolean }) {
    let file = this.files.get(name);
    if (!file && options?.create) {
      file = new FakeFileHandle();
      this.files.set(name, file);
    }
    if (!file) return Promise.reject(new Error(`no file: ${name}`));
    return Promise.resolve(file);
  }
}

// 不依赖 jsdom 缺失的 Response/ReadableStream 全局：只提供
// writeTreeToDirectory 消费的字段（ok/status/headers.get/body.getReader）。
function fakeRes(chunks: Uint8Array[]) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/octet-stream" },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined },
      }),
    },
  } as unknown as Response;
}

function dirEntry(relPath: string): DiskEntry {
  return { key: relPath, relPath, size: 0, dir: true };
}

function fileEntry(relPath: string, size: number): DiskEntry {
  return { key: relPath, relPath, size };
}

describe("writeTreeToDirectory", () => {
  test("按目录结构写盘（含子目录与空目录占位）并回报字节进度", async () => {
    const root = new FakeDirHandle();
    const reports: Array<[number, number]> = [];
    await writeTreeToDirectory({
      root: root as unknown as FileSystemDirectoryHandle,
      subfolder: "RA2",
      entries: [
        fileEntry("a.txt", 3),
        fileEntry("sub/b.bin", 5),
        dirEntry("empty/"),
      ],
      fetchFile: async (key) =>
        fakeRes(
          key === "a.txt" ? [new Uint8Array([1, 2, 3])] : [new Uint8Array(5)]
        ),
      report: (loaded, total) => reports.push([loaded, total]),
    });
    const ra2 = root.dirs.get("RA2");
    expect(ra2).toBeDefined();
    const a = ra2!.files.get("a.txt")!.writable;
    expect(a.byteLength).toBe(3);
    expect(a.closed).toBe(true);
    expect(ra2!.dirs.get("sub")!.files.get("b.bin")!.writable.byteLength).toBe(
      5
    );
    expect(ra2!.dirs.get("empty")).toBeDefined();
    expect(reports[0]).toEqual([0, 8]);
    expect(reports.at(-1)).toEqual([8, 8]);
  });

  test("空 subfolder 直接写根", async () => {
    const root = new FakeDirHandle();
    await writeTreeToDirectory({
      root: root as unknown as FileSystemDirectoryHandle,
      subfolder: "",
      entries: [fileEntry("top.txt", 1)],
      fetchFile: async () => fakeRes([new Uint8Array([9])]),
      report: vi.fn(),
    });
    expect(root.files.get("top.txt")!.writable.byteLength).toBe(1);
  });

  test("signal 已中止 → 抛 AbortError 且不建任何目录/文件", async () => {
    const root = new FakeDirHandle();
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeTreeToDirectory({
        root: root as unknown as FileSystemDirectoryHandle,
        subfolder: "x",
        entries: [fileEntry("a.txt", 1)],
        fetchFile: async () => fakeRes([new Uint8Array([1])]),
        report: vi.fn(),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(root.dirs.size).toBe(0);
    expect(root.files.size).toBe(0);
  });

  test("拉流失败 → 对应 writable 被 abort（临时文件丢弃）", async () => {
    const root = new FakeDirHandle();
    await expect(
      writeTreeToDirectory({
        root: root as unknown as FileSystemDirectoryHandle,
        subfolder: "",
        entries: [fileEntry("bad.txt", 3)],
        fetchFile: async () => {
          throw new Error("network gone");
        },
        report: vi.fn(),
      })
    ).rejects.toThrow("network gone");
    const writable = root.files.get("bad.txt")!.writable;
    expect(writable.aborted).toBe(true);
    expect(writable.closed).toBe(false);
  });

  test("HTTP 非 2xx → 抛错并 abort", async () => {
    const root = new FakeDirHandle();
    await expect(
      writeTreeToDirectory({
        root: root as unknown as FileSystemDirectoryHandle,
        subfolder: "",
        entries: [fileEntry("a.txt", 1)],
        fetchFile: async () =>
          ({
            ok: false,
            status: 502,
            headers: { get: () => "text/plain" },
            body: null,
          }) as unknown as Response,
        report: vi.fn(),
      })
    ).rejects.toThrow("HTTP 502: a.txt");
    expect(root.files.get("a.txt")!.writable.aborted).toBe(true);
  });

  test("目录占位对象被误判为文件 → 补建目录，不产 0 字节假文件", async () => {
    const root = new FakeDirHandle();
    await writeTreeToDirectory({
      root: root as unknown as FileSystemDirectoryHandle,
      subfolder: "",
      entries: [fileEntry("m/n", 5)],
      fetchFile: async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => "application/x-directory" },
          body: {
            getReader: () => ({
              read: async () => ({ done: true, value: undefined }),
            }),
          },
        }) as unknown as Response,
      report: vi.fn(),
    });
    expect(root.dirs.get("m")!.dirs.get("n")).toBeDefined();
    // 文件句柄是 openWritable 建的，但 writable 已 abort，内容未落
    const handle = root.dirs.get("m")!.files.get("n");
    if (handle) {
      expect(handle.writable.aborted).toBe(true);
      expect(handle.writable.byteLength).toBe(0);
    }
  });
});

describe("目录选择器（pickTargetDirectory / supportsDiskWrite）", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });

  test("无 showDirectoryPicker → 不支持且返回 null", async () => {
    expect(supportsDiskWrite()).toBe(false);
    await expect(pickTargetDirectory()).resolves.toBeNull();
  });

  test("选择成功 → 返回句柄，且带 readwrite 模式调用", async () => {
    const handle = { kind: "directory" };
    (window as unknown as Record<string, unknown>).showDirectoryPicker = vi
      .fn()
      .mockResolvedValue(handle);
    expect(supportsDiskWrite()).toBe(true);
    await expect(pickTargetDirectory()).resolves.toBe(handle);
    expect(
      (window as unknown as { showDirectoryPicker: Mock }).showDirectoryPicker
    ).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  test("用户取消（AbortError）→ 静默返回 null", async () => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker = vi
      .fn()
      .mockRejectedValue(new DOMException("canceled", "AbortError"));
    await expect(pickTargetDirectory()).resolves.toBeNull();
  });

  test("其他错误（如 SecurityError）→ 原样抛出", async () => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker = vi
      .fn()
      .mockRejectedValue(new DOMException("denied", "SecurityError"));
    await expect(pickTargetDirectory()).rejects.toMatchObject({
      name: "SecurityError",
    });
  });
});
