import UPNG from "upng-js";

export const PALETTES = [256, 192, 128, 96, 64, 48, 32, 24, 16];

function encode(rgba, width, height, colors) {
  const source = rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength
    ? rgba.buffer
    : rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
  return new Uint8Array(UPNG.encode([source], width, height, colors));
}

function paletteLabel(colors, resized) {
  const prefix = resized ? "微损压缩并缩小尺寸" : "微损调色板压缩";
  return `${prefix}（${colors} 色）`;
}

function paletteResult(png, width, height, colors, resized, withinTarget) {
  return {
    png,
    outputBytes: png.byteLength,
    width,
    height,
    withinTarget,
    method: resized ? "resized-palette" : "palette",
    colors,
    methodLabel: paletteLabel(colors, resized),
  };
}

export async function compressRgba({
  pixels,
  width,
  height,
  targetBytes,
  losslessOnly = false,
  allowResize = true,
  resizeRgba,
}) {
  let rgba = pixels instanceof Uint8ClampedArray
    ? pixels
    : new Uint8ClampedArray(pixels);
  let currentWidth = width;
  let currentHeight = height;
  let png = encode(rgba, currentWidth, currentHeight, 0);

  if (png.byteLength <= targetBytes || losslessOnly) {
    return {
      png,
      outputBytes: png.byteLength,
      width: currentWidth,
      height: currentHeight,
      withinTarget: png.byteLength <= targetBytes,
      method: "lossless",
      methodLabel: "无损压缩",
    };
  }

  let smallest = png;
  let smallestColors = 0;
  for (const colors of PALETTES) {
    const candidate = encode(rgba, currentWidth, currentHeight, colors);
    if (candidate.byteLength < smallest.byteLength) {
      smallest = candidate;
      smallestColors = colors;
    }
    if (candidate.byteLength <= targetBytes) {
      return paletteResult(candidate, currentWidth, currentHeight, colors, false, true);
    }
  }

  if (!allowResize) {
    return paletteResult(
      smallest,
      currentWidth,
      currentHeight,
      smallestColors,
      false,
      false,
    );
  }
  if (typeof resizeRgba !== "function") {
    throw new Error("A resizeRgba implementation is required when resizing is enabled.");
  }

  for (let pass = 0; pass < 14; pass += 1) {
    const estimated = Math.sqrt(targetBytes / Math.max(smallest.byteLength, 1)) * 0.96;
    const scale = Math.min(0.92, Math.max(0.62, estimated));
    const nextWidth = Math.max(32, Math.floor(currentWidth * scale));
    const nextHeight = Math.max(32, Math.floor(currentHeight * scale));
    if (nextWidth === currentWidth && nextHeight === currentHeight) break;

    rgba = await resizeRgba(rgba, currentWidth, currentHeight, nextWidth, nextHeight);
    currentWidth = nextWidth;
    currentHeight = nextHeight;

    for (const colors of PALETTES) {
      const candidate = encode(rgba, currentWidth, currentHeight, colors);
      if (candidate.byteLength < smallest.byteLength) {
        smallest = candidate;
        smallestColors = colors;
      }
      if (candidate.byteLength <= targetBytes) {
        return paletteResult(candidate, currentWidth, currentHeight, colors, true, true);
      }
    }
  }

  return paletteResult(
    smallest,
    currentWidth,
    currentHeight,
    smallestColors,
    true,
    smallest.byteLength <= targetBytes,
  );
}
