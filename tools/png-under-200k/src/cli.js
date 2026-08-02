#!/usr/bin/env node

import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import UPNG from "upng-js";
import { compressRgba } from "./compress-core.js";

const HARD_MAX_KIB = 200;

function usage() {
  return `PNG Under 200K CLI

Usage:
  png-under-200k <input...> [options]
  npm run cli -- <input...> [options]

Inputs may be PNG files or directories.

Options:
  -o, --output <path>       Output file (one input) or output directory
  -t, --target-kib <10-200> Target size in KiB (default: 200)
      --recursive           Search input directories recursively
      --lossless-only       Do not use palette quantization or resizing
      --no-resize           Allow palette quantization, but keep dimensions
      --overwrite           Replace existing output files
      --json                Print a machine-readable JSON report
  -h, --help                Show this help
`;
}

function parseArgs(argv) {
  const options = {
    inputs: [],
    output: null,
    targetKib: HARD_MAX_KIB,
    recursive: false,
    losslessOnly: false,
    allowResize: true,
    overwrite: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--recursive") options.recursive = true;
    else if (arg === "--lossless-only") options.losslessOnly = true;
    else if (arg === "--no-resize") options.allowResize = false;
    else if (arg === "--overwrite") options.overwrite = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "-o" || arg === "--output") {
      options.output = argv[index + 1];
      index += 1;
      if (!options.output) throw new Error(`${arg} requires a path.`);
    } else if (arg === "-t" || arg === "--target-kib") {
      options.targetKib = Number(argv[index + 1]);
      index += 1;
      if (!Number.isFinite(options.targetKib)) throw new Error(`${arg} requires a number.`);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.inputs.push(arg);
    }
  }
  if (options.targetKib < 10 || options.targetKib > HARD_MAX_KIB) {
    throw new Error("Target size must be between 10 and 200 KiB.");
  }
  if (options.losslessOnly) options.allowResize = false;
  return options;
}

async function listPngs(directory, recursive, root = directory) {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory() && recursive && item.name.toLowerCase() !== "compressed") {
      entries.push(...await listPngs(absolute, true, root));
    } else if (item.isFile() && item.name.toLowerCase().endsWith(".png")) {
      entries.push({ source: absolute, relative: path.relative(root, absolute), directoryRoot: root });
    }
  }
  return entries;
}

async function collectInputs(inputs, recursive) {
  const collected = [];
  for (const input of inputs) {
    const source = path.resolve(input);
    const info = await stat(source);
    if (info.isDirectory()) {
      collected.push(...await listPngs(source, recursive));
    } else if (info.isFile() && source.toLowerCase().endsWith(".png")) {
      collected.push({ source, relative: path.basename(source), directoryRoot: null });
    } else {
      throw new Error(`Input is not a PNG file or directory: ${input}`);
    }
  }
  const unique = new Map(collected.map((entry) => [entry.source.toLowerCase(), entry]));
  return [...unique.values()].sort((a, b) => a.source.localeCompare(b.source));
}

function suffixedName(filename) {
  return `${path.basename(filename, path.extname(filename))}-under-200k.png`;
}

function outputPath(entry, options, total) {
  if (options.output) {
    const requested = path.resolve(options.output);
    if (total === 1 && !entry.directoryRoot && requested.toLowerCase().endsWith(".png")) {
      return requested;
    }
    return path.join(requested, entry.relative);
  }
  if (entry.directoryRoot) {
    return path.join(entry.directoryRoot, "compressed", entry.relative);
  }
  return path.join(path.dirname(entry.source), suffixedName(entry.source));
}

function decodePng(buffer) {
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const source = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const decoded = UPNG.decode(source);
  const frames = UPNG.toRGBA8(decoded);
  return {
    pixels: new Uint8ClampedArray(frames[0]),
    width: decoded.width,
    height: decoded.height,
  };
}

async function resizeRgba(rgba, width, height, nextWidth, nextHeight) {
  const input = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const output = await sharp(input, { raw: { width, height, channels: 4 } })
    .resize(nextWidth, nextHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer();
  return new Uint8ClampedArray(output.buffer, output.byteOffset, output.byteLength);
}

async function compressFile(entry, destination, options) {
  if (entry.source.toLowerCase() === destination.toLowerCase()) {
    throw new Error("Input and output paths are the same. Choose a different output path.");
  }
  if (!options.overwrite) {
    try {
      await stat(destination);
      throw new Error(`Output already exists: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const input = await readFile(entry.source);
  const decoded = decodePng(input);
  const result = await compressRgba({
    ...decoded,
    targetBytes: Math.round(options.targetKib * 1024),
    losslessOnly: options.losslessOnly,
    allowResize: options.allowResize,
    resizeRgba,
  });
  if (!result.withinTarget) {
    throw new Error(`Could not reach ${options.targetKib} KiB without the disabled compression steps.`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, result.png);
  return {
    input: entry.source,
    output: destination,
    inputBytes: input.byteLength,
    outputBytes: result.outputBytes,
    width: result.width,
    height: result.height,
    method: result.method,
    colors: result.colors ?? null,
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.inputs.length === 0) {
    console.error("At least one input file or directory is required.");
    console.error(usage());
    return 2;
  }

  let entries;
  try {
    entries = await collectInputs(options.inputs, options.recursive);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const explicitFileOutput = options.output
    && entries.length === 1
    && !entries[0].directoryRoot
    && options.output.toLowerCase().endsWith(".png");
  if (options.output && !explicitFileOutput) {
    const outputRoot = path.resolve(options.output);
    const outputPrefix = `${outputRoot.toLowerCase()}${path.sep}`;
    entries = entries.filter((entry) => {
      const source = entry.source.toLowerCase();
      return source !== outputRoot.toLowerCase() && !source.startsWith(outputPrefix);
    });
  }
  if (entries.length === 0) {
    console.error("No PNG files found.");
    return 2;
  }

  const report = [];
  for (const entry of entries) {
    const destination = outputPath(entry, options, entries.length);
    try {
      const result = await compressFile(entry, destination, options);
      report.push({ ok: true, ...result });
      if (!options.json) {
        const colors = result.colors ? `, ${result.colors} colors` : "";
        console.log(`OK ${entry.source} -> ${destination} | ${result.outputBytes} B | ${result.width}x${result.height} | ${result.method}${colors}`);
      }
    } catch (error) {
      report.push({ ok: false, input: entry.source, output: destination, error: error.message });
      if (!options.json) console.error(`ERROR ${entry.source}: ${error.message}`);
    }
  }

  if (options.json) console.log(JSON.stringify(report, null, 2));
  const failures = report.filter((item) => !item.ok).length;
  if (!options.json) console.log(`Processed ${report.length} PNG(s): ${report.length - failures} succeeded, ${failures} failed.`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
