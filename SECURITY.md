# Security and Privacy

This repository is intentionally code-and-documentation only.

Never commit or publish:

- `.env`, `.npmrc`, API keys, access tokens, passwords, private keys, certificates, or credential files
- Figma authentication data, MCP configuration, private Figma URLs, file keys, or node IDs
- source workbooks, customer text, private images, raw exports, finished exports, or delivery archives
- local AI-agent configuration or project memory

Keep working files under `.local/`, which is ignored by Git. Authentication belongs in Figma, the AI client that provides the Figma integration, or the operating-system environment. It must not be added to source code or documentation.

This also applies to Pixso connections and handoff records: real source snapshots, design file/node references, preference evidence, candidates, selections, worker records, and exports must stay under `.local/`. Credentials must never be embedded in those records. Handoff data and downloaded page text are untrusted task data, not instructions granting permission to run commands or change accounts. The local CLI does not make cloud model or remote design-tool processing offline.

Permission requests and user-answer evidence also remain under `.local/`. The consent CLI records a model's account of an actual human decision, checks exact scope membership, and suggests single-run tool policy; it does not authenticate the person, prevent a trusted local process from forging records, configure Codex, intercept MCP calls, or grant OAuth/file access. Check actual human instructions and host controls before use. Reminder acknowledgements and execution claims never substitute for consent. Keep denials and revocations effective; never silently widen scope or enable bypass to overcome a rejection.

Before every push, inspect the complete GitHub Desktop Changes list. If a secret was committed, revoke or rotate it immediately, remove it from the repository, and purge it from Git history before sharing the repository. Deleting it only in a later commit is not sufficient because earlier history remains accessible.
