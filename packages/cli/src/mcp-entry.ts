// Entry of the bridge bundled into the Claude Code plugin (integrations/claude-code/mcp/conus-mcp.mjs):
// the plugin starts it with `node`, so it works without `conus` on PATH and without .cmd shims on Windows.
import { serveMcp } from './mcp-main';

await serveMcp();
