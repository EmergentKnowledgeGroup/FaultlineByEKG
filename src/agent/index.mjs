// src/agent: the compact view of the map for an agent. agentData builds it, the six commands read it, the MCP server serves them.
export { agentData, SCHEMA } from './data.mjs';
export { brief, where, breaks, path, impact, status, COMMANDS } from './commands.mjs';
export { BUDGET, resolve, levelOf, makeCtx } from './view.mjs';
export { makeServer, serve, TOOLS } from './mcp.mjs';
