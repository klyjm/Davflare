import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { saveEntriesAsZip, supportsDiskZip, type ZipEntry } from "../zipClient";

class FakeWritable {
  chunks: Uint8Array[] = [];
  closed = false;
  aborted: unknown = null;

  async write(data: Uint8Array) {
    this.chunks.push(data);
  }
  async close() {
    this.closed = true;
  }
  async abort(reason?: unknown) {
    this.aborted = reason ?? true;
  }
}

function stubPicker(): FakeWritable {
  const writable = new FakeWritable();
  (window as unknown as Record<string, unknown>).showSaveFilePicker = async () => ({
    createWritable: async () => writable,
  });
  return writable;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function zipEntries(): ZipEntry[] {
  return [
    { key: "f/a.txt", relPath: "a.txt", size: 5 },
    { key: "f/empty", relPath: "empty/", size: 0, dir: true },
    { key: "f/sub/b.txt", relPath: "sub/b.txt", size: 5, uploaded: "2026-09-29T00:00:00Z" },
  ];
}

describe("zipClient", () => {
  it("supportsDiskZip follows showSaveFilePicker availability", () => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    expect(supportsDiskZip()).toBe(false);
    stubPicker();
    expect(supportsDiskZip()).toBe(true);
  });

  it("streams files and dir placeholders into a valid zip", async () => {
    const writable = stubPicker();
    await saveEntriesAsZip(
      "x.zip",
      async () => zipEntries(),
      async (key) => new Response(key === "f/a.txt" ? "hello" : "world")
    );

    expect(writable.closed).toBe(true);
    expect(writable.aborted).toBeNull();
    const un = unzipSync(concat(writable.chunks));
    expect(strFromU8(un["a.txt"])).toBe("hello");
    expect(strFromU8(un["sub/b.txt"])).toBe("world");
    expect(un["empty/"]).toBeDefined();
  });

  it("aborts the partial file when a download fails", async () => {
    const writable = stubPicker();
    await expect(
      saveEntriesAsZip(
        "x.zip",
        async () => zipEntries(),
        async (key) =>
          key === "f/a.txt" ? new Response("hello") : new Response("boom", { status: 500 })
      )
    ).rejects.toThrow(/500/);

    expect(writable.closed).toBe(false);
    expect(writable.aborted).not.toBeNull();
  });
});
