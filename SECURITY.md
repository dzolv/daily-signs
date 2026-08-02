# Security and Privacy

This repository is intentionally code-and-documentation only.

Never commit or publish:

- `.env`, `.npmrc`, API keys, access tokens, passwords, private keys, certificates, or credential files
- Figma authentication data, MCP configuration, private Figma URLs, file keys, or node IDs
- source workbooks, customer text, private images, raw exports, finished exports, or delivery archives
- local AI-agent configuration or project memory

Keep working files under `.local/`, which is ignored by Git. Authentication belongs in Figma, the AI client that provides the Figma integration, or the operating-system environment. It must not be added to source code or documentation.

Before every push, inspect the complete GitHub Desktop Changes list. If a secret was committed, revoke or rotate it immediately, remove it from the repository, and purge it from Git history before sharing the repository. Deleting it only in a later commit is not sufficient because earlier history remains accessible.
