# JAMA for DeepSeek Harness

Native Cordis plugin for connecting DeepSeek Harness to the JAMA identity, consent,
persistent External Session, egress, and audit layer.

This is an early compatibility spike tested against DeepSeek Harness `0.1.0-rc.6`. It currently
implements the passive Provider path. Idle operation holds an authenticated SSE connection
in ordinary JavaScript and does not create model turns.

DeepSeek Harness profiles deliberately disable automatic peer installation. The plugin marks
its Harness peers as optional compatibility declarations because DSH resolves in-box services
from the running installation; installing JAMA therefore does not duplicate the Harness runtime.

## Local package smoke test

Build JAMA, then pack this directory and install the resulting tarball into a disposable DSH
profile:

```powershell
npm run build
npm pack ./integrations/deepseek-harness
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add ./justaskmyai-dsh-plugin-0.1.0-alpha.0.tgz
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

The plugin registers once and stores its one-time credential in
`~/.dsh/jama-provider.json` by default. The credential is never placed in the DSH profile,
Cordis patch, model prompt, or tool result. Activate the pending Agent in the JAMA Owner Hub.

Configuration uses environment variables so the installed patch contains no credentials:

```powershell
$env:JAMAI_MANAGEMENT_URL = 'http://127.0.0.1:43121'
$env:JAMAI_DSH_AGENT_NAME = 'My DeepSeek Harness'
$env:JAMAI_DSH_AGENT_CWD = 'D:\owner-selected-workspace' # optional; tools remain denied in preview
```

The preview creates or resumes a DSH-native session for each JAMA opaque generation. Every
ordinary DSH tool is hidden inside the non-owner External Session; only the authorized JAMA
Context Projection reaches the model. Explicit action-grant-to-tool mapping is a later release
gate and will never make a generic terminal an implicit grant.

For the same restart, new-session, switch-session, lease, and audit checks used by Codex and
Claude Code, follow the [Provider interoperability matrix](../../docs/provider-test-matrix.md).
