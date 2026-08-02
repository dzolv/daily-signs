import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  Check,
  Download,
  FileImage,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import "./styles.css";

const HARD_MAX_KIB = 200;
const worker = new Worker(new URL("./png.worker.js", import.meta.url), {
  type: "module",
});

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
}

function outputName(name) {
  const base = name.replace(/\.png$/i, "");
  return `${base}-under-200k.png`;
}

async function decodePng(file) {
  const bitmap = await createImageBitmap(file);
  const pixels = bitmap.width * bitmap.height;
  if (pixels > 50_000_000) {
    bitmap.close();
    throw new Error("图片超过 5000 万像素，为避免浏览器内存不足，请先缩小图片。" );
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", {
    alpha: true,
    colorSpace: "srgb",
    willReadFrequently: true,
  });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    pixels: imageData.data.buffer,
    width: canvas.width,
    height: canvas.height,
  };
}

function Stat({ label, value, tone }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong className={tone ? `tone-${tone}` : ""}>{value}</strong>
    </div>
  );
}

function Preview({ src, label, fallback, bytes }) {
  return (
    <div className="preview">
      <div className="preview-label">{label}</div>
      {src ? <img src={src} alt={label} data-bytes={bytes ?? undefined} /> : <div className="preview-empty">{fallback}</div>}
    </div>
  );
}

function App() {
  const inputRef = useRef(null);
  const jobIdRef = useRef(0);
  const sourceUrlRef = useRef("");
  const resultUrlRef = useRef("");
  const [file, setFile] = useState(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [targetKib, setTargetKib] = useState(HARD_MAX_KIB);
  const [mode, setMode] = useState("smart");
  const [allowResize, setAllowResize] = useState(true);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const onMessage = (event) => {
      if (event.data.jobId !== jobIdRef.current) return;
      if (event.data.type === "error") {
        setStatus("error");
        setError(event.data.message);
        return;
      }

      const bytes = new Uint8Array(event.data.png);
      const blob = new Blob([bytes], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      setResult((previous) => {
        if (previous?.url) URL.revokeObjectURL(previous.url);
        return { ...event.data, blob, url };
      });
      setStatus(event.data.withinTarget ? "done" : "error");
      if (!event.data.withinTarget) {
        setError("仅无损模式无法达到目标。切换到自动保真后可继续压缩。" );
      }
    };
    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    sourceUrlRef.current = sourceUrl;
    resultUrlRef.current = result?.url || "";
  }, [sourceUrl, result]);

  useEffect(() => () => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
  }, []);

  const ratio = useMemo(() => {
    if (!file || !result) return null;
    return Math.max(0, (1 - result.outputBytes / file.size) * 100);
  }, [file, result]);

  const reset = () => {
    jobIdRef.current += 1;
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    if (result?.url) URL.revokeObjectURL(result.url);
    setFile(null);
    setSourceUrl("");
    setResult(null);
    setStatus("idle");
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const selectFile = (nextFile) => {
    if (!nextFile) return;
    if (nextFile.type !== "image/png" && !nextFile.name.toLowerCase().endsWith(".png")) {
      setError("只接受 PNG 文件。" );
      setStatus("error");
      return;
    }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    if (result?.url) URL.revokeObjectURL(result.url);
    setFile(nextFile);
    setSourceUrl(URL.createObjectURL(nextFile));
    setResult(null);
    setError("");
    setStatus("ready");
  };

  const compress = async () => {
    if (!file || status === "working") return;
    const safeTarget = Math.min(HARD_MAX_KIB, Math.max(10, Number(targetKib) || HARD_MAX_KIB));
    setTargetKib(safeTarget);
    setStatus("working");
    setError("");
    setResult((previous) => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return null;
    });
    const jobId = jobIdRef.current + 1;
    jobIdRef.current = jobId;

    try {
      const decoded = await decodePng(file);
      worker.postMessage(
        {
          type: "compress",
          jobId,
          ...decoded,
          targetBytes: safeTarget * 1024,
          losslessOnly: mode === "lossless",
          allowResize: mode === "smart" && allowResize,
        },
        [decoded.pixels],
      );
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "无法读取这张 PNG。" );
    }
  };

  const download = () => {
    if (!result?.url || !file) return;
    const anchor = document.createElement("a");
    anchor.href = result.url;
    anchor.download = outputName(file.name);
    anchor.click();
  };

  const drop = (event) => {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files?.[0]);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><FileImage size={21} /></div>
          <div>
            <h1>PNG 压缩工具</h1>
            <p>严格控制在 200 KiB 以内</p>
          </div>
        </div>
        <div className="privacy"><ShieldCheck size={17} /> 图片仅在本机浏览器处理</div>
      </header>

      <main>
        {!file ? (
          <section
            className={`dropzone ${dragging ? "is-dragging" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept="image/png,.png"
              onChange={(event) => selectFile(event.target.files?.[0])}
            />
            <div className="drop-icon"><ImagePlus size={31} /></div>
            <h2>拖入一张 PNG</h2>
            <p>或点击选择文件。支持透明背景，静态 PNG，最大 5000 万像素。</p>
            <button type="button" className="button primary"><Upload size={18} /> 选择 PNG</button>
          </section>
        ) : (
          <div className="workspace">
            <section className="controls-panel">
              <div className="file-row">
                <div className="file-icon"><FileImage size={22} /></div>
                <div className="file-copy">
                  <strong title={file.name}>{file.name}</strong>
                  <span>{formatBytes(file.size)}</span>
                </div>
                <button type="button" className="icon-button" onClick={reset} title="移除图片" aria-label="移除图片">
                  <Trash2 size={18} />
                </button>
              </div>

              <div className="control-group">
                <label htmlFor="target">目标体积</label>
                <div className="number-control">
                  <input
                    id="target"
                    type="number"
                    min="10"
                    max="200"
                    step="1"
                    value={targetKib}
                    onChange={(event) => setTargetKib(event.target.value)}
                  />
                  <span>KiB</span>
                </div>
                <small>最大值锁定为 200 KiB（204,800 字节）</small>
              </div>

              <div className="control-group">
                <span className="label">压缩方式</span>
                <div className="segmented" role="group" aria-label="压缩方式">
                  <button type="button" className={mode === "smart" ? "active" : ""} onClick={() => setMode("smart")}>自动保真</button>
                  <button type="button" className={mode === "lossless" ? "active" : ""} onClick={() => setMode("lossless")}>仅无损</button>
                </div>
              </div>

              <label className={`toggle-row ${mode === "lossless" ? "disabled" : ""}`}>
                <span>
                  <strong>必要时缩小尺寸</strong>
                  <small>只在颜色量化仍无法达标时启用</small>
                </span>
                <input
                  type="checkbox"
                  checked={allowResize}
                  disabled={mode === "lossless"}
                  onChange={(event) => setAllowResize(event.target.checked)}
                />
                <i aria-hidden="true" />
              </label>

              <button type="button" className="button primary wide" onClick={compress} disabled={status === "working"}>
                {status === "working" ? <><LoaderCircle className="spin" size={18} /> 正在压缩</> : <><RefreshCw size={18} /> 开始压缩</>}
              </button>
            </section>

            <section className="result-panel">
              <div className="previews">
                <Preview src={sourceUrl} label="原图" fallback="等待原图" />
                <Preview src={result?.url} label="压缩后" bytes={result?.outputBytes} fallback={status === "working" ? "正在生成预览" : "点击开始压缩"} />
              </div>

              <div className="stats-grid">
                <Stat label="原始体积" value={formatBytes(file.size)} />
                <Stat label="输出体积" value={formatBytes(result?.outputBytes)} tone={result?.withinTarget ? "success" : undefined} />
                <Stat label="体积减少" value={ratio == null ? "-" : `${ratio.toFixed(1)}%`} />
                <Stat label="输出尺寸" value={result ? `${result.width} × ${result.height}` : "-"} />
              </div>

              {status === "done" && result && (
                <div className="notice success">
                  <Check size={18} />
                  <span>{result.methodLabel}，输出已通过 200 KiB 硬限制检查。</span>
                </div>
              )}
              {error && (
                <div className="notice error">
                  <AlertCircle size={18} />
                  <span>{error}</span>
                </div>
              )}

              <button type="button" className="button download wide" onClick={download} disabled={!result?.withinTarget}>
                <Download size={18} /> 下载压缩后的 PNG
              </button>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
