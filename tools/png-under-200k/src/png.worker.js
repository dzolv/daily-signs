import { compressRgba } from "./compress-core.js";

function resizeRgba(rgba, width, height, nextWidth, nextHeight) {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("当前浏览器不支持后台缩放，请关闭“必要时缩小尺寸”或使用最新版 Chrome。" );
  }
  const source = new OffscreenCanvas(width, height);
  const sourceContext = source.getContext("2d", { alpha: true });
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);

  const output = new OffscreenCanvas(nextWidth, nextHeight);
  const outputContext = output.getContext("2d", { alpha: true, willReadFrequently: true });
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = "high";
  outputContext.drawImage(source, 0, 0, nextWidth, nextHeight);
  return outputContext.getImageData(0, 0, nextWidth, nextHeight).data;
}

self.onmessage = async (event) => {
  if (event.data.type !== "compress") return;
  const {
    jobId,
    pixels,
    width,
    height,
    targetBytes,
    losslessOnly,
    allowResize,
  } = event.data;

  try {
    const result = await compressRgba({
      pixels,
      width,
      height,
      targetBytes,
      losslessOnly,
      allowResize,
      resizeRgba,
    });
    const png = result.png.byteOffset === 0
      && result.png.byteLength === result.png.buffer.byteLength
      ? result.png.buffer
      : result.png.buffer.slice(result.png.byteOffset, result.png.byteOffset + result.png.byteLength);
    self.postMessage({ type: "result", jobId, ...result, png }, [png]);
  } catch (cause) {
    self.postMessage({
      type: "error",
      jobId,
      message: cause instanceof Error ? cause.message : "压缩失败，请换一张 PNG 重试。",
    });
  }
};
