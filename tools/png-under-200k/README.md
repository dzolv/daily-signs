# PNG Under 200K

Daily Signs 项目的从属本地工具，用于将静态 PNG 严格压缩到不超过 200 KiB。

## Run from the repository root

```powershell
npm install
npm run dev
```

## CLI

Compress one PNG and choose the output file:

```powershell
npm run compress -- .\input.png -o .\output.png
```

Compress every PNG in a directory. Results are written to a `compressed`
subdirectory by default:

```powershell
npm run compress -- .\input-directory
```

Use `--recursive` for nested directories, `--no-resize` to keep dimensions,
or `--lossless-only` to reject any image that cannot meet the target without
lossy steps. Run `npm run compress -- --help` for all options. The target is capped
at 200 KiB.

The default smart mode tries, in order:

1. Lossless PNG recompression.
2. Palette quantization at the original dimensions.
3. Progressive high-quality resizing plus palette quantization when needed.

Images are processed locally in a Web Worker and are not uploaded. Animated PNG files are treated as static images.
