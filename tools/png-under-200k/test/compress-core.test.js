import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import UPNG from "upng-js";
import { compressRgba } from "../src/compress-core.js";

function rgbaBuffer(width, height, random = false) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  let state = 0x12345678;
  for (let index = 0; index < pixels.length; index += 4) {
    if (random) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels[index] = state & 255;
      pixels[index + 1] = (state >>> 8) & 255;
      pixels[index + 2] = (state >>> 16) & 255;
    } else {
      pixels[index] = 24;
      pixels[index + 1] = 96;
      pixels[index + 2] = 160;
    }
    pixels[index + 3] = 255;
  }
  return pixels;
}

function encode(pixels, width, height) {
  return Buffer.from(UPNG.encode([pixels.buffer], width, height, 0));
}

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(cwd, "src", "cli.js"), ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("compressRgba keeps a small image within the target", async () => {
  const result = await compressRgba({
    pixels: rgbaBuffer(32, 32),
    width: 32,
    height: 32,
    targetBytes: 204800,
    allowResize: false,
  });
  assert.equal(result.withinTarget, true);
  assert.equal(result.width, 32);
  assert.equal(result.height, 32);
  assert.ok(result.outputBytes <= 204800);
});

test("CLI compresses a PNG to the strict default target", async () => {
  const cwd = path.resolve(import.meta.dirname, "..");
  const temporary = await mkdtemp(path.join(tmpdir(), "png-under-200k-"));
  try {
    const input = path.join(temporary, "input.png");
    const output = path.join(temporary, "output.png");
    await writeFile(input, encode(rgbaBuffer(630, 630, true), 630, 630));
    const result = await runCli([input, "-o", output], cwd);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const compressed = await readFile(output);
    assert.ok(compressed.byteLength <= 204800);
    assert.deepEqual([...compressed.subarray(0, 4)], [137, 80, 78, 71]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
