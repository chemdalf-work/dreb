/**
 * Tools Configuration
 *
 * Use built-in tool sets or individual tools.
 *
 * IMPORTANT: When using a custom `cwd`, you must use the tool factory functions
 * (createCodingTools, createReadOnlyTools, createReadTool, etc.) to ensure
 * tools resolve paths relative to your cwd, not process.cwd().
 *
 * For custom tools, see 06-extensions.ts - custom tools are now registered
 * via the extensions system using dreb.registerTool().
 */

import {
	bashTool,
	createAgentSession,
	createBashTool,
	createCodingTools,
	createGrepTool,
	createReadTool,
	grepTool,
	readOnlyTools,
	readTool,
	SessionManager,
} from "@dreb/coding-agent";

// Read-only mode (no edit/write) - uses process.cwd()
const { session: readOnlySession } = await createAgentSession({
	tools: readOnlyTools,
	sessionManager: SessionManager.inMemory(),
});
try {
	console.log("Read-only session created");
} finally {
	await readOnlySession.dispose();
}

// Custom tool selection - uses process.cwd()
const { session: customToolsSession } = await createAgentSession({
	tools: [readTool, bashTool, grepTool],
	sessionManager: SessionManager.inMemory(),
});
try {
	console.log("Custom tools session created");
} finally {
	await customToolsSession.dispose();
}

// With custom cwd - MUST use factory functions!
const customCwd = "/path/to/project";
const { session: customCwdSession } = await createAgentSession({
	cwd: customCwd,
	tools: createCodingTools(customCwd), // Tools resolve paths relative to customCwd
	sessionManager: SessionManager.inMemory(),
});
try {
	console.log("Custom cwd session created");
} finally {
	await customCwdSession.dispose();
}

// Or pick specific tools for custom cwd
const { session: specificToolsSession } = await createAgentSession({
	cwd: customCwd,
	tools: [createReadTool(customCwd), createBashTool(customCwd), createGrepTool(customCwd)],
	sessionManager: SessionManager.inMemory(),
});
try {
	console.log("Specific tools with custom cwd session created");
} finally {
	await specificToolsSession.dispose();
}
