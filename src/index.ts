#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { debug } from './config.js';
import { runSetup } from './setup.js';
import { createOpenAlexMcpServer } from './openalex-mcp-server.js';
import { startStreamableHttpServer } from './streamable-http.js';

function wantsHttpTransport(): boolean {
  if (process.argv.includes('--http')) return true;
  const mode = process.env.MCP_TRANSPORT?.toLowerCase();
  return mode === 'http' || mode === 'streamable-http';
}

// Handle `openalex-research-mcp setup [flags]` before starting the MCP server
if (process.argv[2] === 'setup') {
  runSetup(process.argv.slice(3)).then(() => process.exit(0)).catch(err => {
    console.error('Setup failed:', err.message);
    process.exit(1);
  });
} else {
  async function main() {
    if (wantsHttpTransport()) {
      await startStreamableHttpServer();
      return;
    }

    const server = createOpenAlexMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    debug('Server running on stdio');
  }

  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
