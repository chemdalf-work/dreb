/**
 * API Keys and OAuth
 *
 * Configure API key resolution via AuthStorage and ModelRegistry.
 */

import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@dreb/coding-agent";

// Default: AuthStorage uses ~/.dreb/agent/auth.json
// ModelRegistry loads built-in + custom models from ~/.dreb/agent/models.json
const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

const { session: defaultSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
try {
	console.log("Session with default auth storage and model registry");
} finally {
	await defaultSession.dispose();
}

// Custom auth storage location
const customAuthStorage = AuthStorage.create("/tmp/my-app/auth.json");
const customModelRegistry = new ModelRegistry(customAuthStorage, "/tmp/my-app/models.json");

const { session: customSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage: customAuthStorage,
	modelRegistry: customModelRegistry,
});
try {
	console.log("Session with custom auth storage location");
} finally {
	await customSession.dispose();
}

// Runtime API key override (not persisted to disk)
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const { session: runtimeKeySession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
try {
	console.log("Session with runtime API key override");
} finally {
	await runtimeKeySession.dispose();
}

// No models.json - only built-in models
const simpleRegistry = new ModelRegistry(authStorage); // null = no models.json
const { session: simpleSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry: simpleRegistry,
});
try {
	console.log("Session with only built-in models");
} finally {
	await simpleSession.dispose();
}
