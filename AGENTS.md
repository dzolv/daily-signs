# Instructions for AI Assistants

This repository is a reusable Figma daily-sign workflow plus a local PNG compression tool.

## Before making changes

- Read `README.md`, `docs/figma-workflow.md`, and `SECURITY.md`.
- Treat the user's chosen Figma frame or template as the sole visual authority. Do not adjust its layout, typography, spacing, masks, layer order, or image composition unless the user explicitly asks.
- Use the user's own Figma account, connection, and file. Never hardcode or commit account IDs, file keys, node IDs, private URLs, credentials, or integration configuration.
- If Figma access is needed, guide the user to configure it inside their own AI client. Never ask them to paste a secret into the repository or chat.

## Private working data

- Keep backgrounds, source documents, workbooks, text, raw exports, finished exports, and temporary files under `.local/`.
- Do not commit actual content data, source images, generated daily signs, delivery ZIP files, credentials, or private Figma identifiers.
- Do not weaken `.gitignore` protections to make a local workflow easier.

## Delivery workflow

- Leave text positioning fixed unless the user explicitly changes the template.
- Let the user choose background image placement and scale in Figma.
- Export the selected frames as 2x PNG files into `.local/export-raw/`.
- Run the shared CLI from the repository root with `npm run compress -- ".local/export-raw" -o ".local/export"`.
- Validate every successful output is a readable PNG no larger than 204,800 bytes.
- The browser UI and CLI must continue to use the same compression core.

## Verification

After code changes, run `npm test` and `npm run build` from this repository root. Keep dependencies installed in this main workspace. When validating merged worktree changes, install dependencies and test inside the worktree containing the merged result; do not borrow another workspace's dependencies.
