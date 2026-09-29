export interface FileItem {
  key: string;
  name: string;
  isDir: boolean;
  size: number;
  uploaded: string;
  contentType: string;
  thumbnail?: string;
}

export type TransferType = "upload" | "download" | "job";

/** 下载任务入队请求：downloadUrl 为带鉴权可 fetch 的地址，name 为保存文件名；
 * 归档打包（POST /api/archive）额外携带 method/body */
export interface DownloadRequest {
  name: string;
  downloadUrl: string;
  init?: { method?: string; body?: string };
}

/** 自定义任务（type === "job"）的执行上下文：report 回报进度，signal 支持取消 */
export interface JobContext {
  signal?: AbortSignal;
  report: (loaded: number, total: number) => void;
}

/** job 任务的入队描述：unit 决定进度单位（字节 or 项数） */
export interface JobSpec {
  name: string;
  unit?: "bytes" | "count";
  total?: number;
  run: (ctx: JobContext) => Promise<void>;
}

export type TransferStatus =
  | "pending"
  | "in-progress"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export interface UploadPart {
  partNumber: number;
  etag: string;
}

export interface TransferTask {
  id: string;
  type: TransferType;
  status: TransferStatus;
  file?: File;
  name: string;
  basedir: string;
  remoteKey: string;
  loaded: number;
  total: number;
  uploadId?: string;
  uploadedParts?: UploadPart[];
  error?: string;
  /** 下载任务（type === "download"）：请求地址与保存文件名 */
  downloadUrl?: string;
  saveAs?: string;
  downloadInit?: { method?: string; body?: string };
  /** 自定义任务（type === "job"，fork 补丁）：进度单位与执行体 */
  unit?: "bytes" | "count";
  job?: (ctx: JobContext) => Promise<void>;
}

export interface ShareInfo {
  token: string;
  key: string;
  name: string;
  expiresAt: string | null;
  /** 旧分享记录可能没有 createdAt（该字段后加），缺省时不展示 */
  createdAt?: string;
  url: string;
  extractCode?: string | null;
  hasExtractCode?: boolean;
}

export interface TrashItem {
  trashKey: string;
  originalKey: string;
  name: string;
  deletedAt: string;
  size: number;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  createdBy?: string | null;
  lastUsedAt?: string | null;
  key?: string;
}

