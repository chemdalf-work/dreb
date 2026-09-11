import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Client screen tests opt into jsdom with a per-file `// @vitest-environment jsdom`
// docblock; server/reducer tests run in the default node environment.
export default defineConfig({
	plugins: [solid()],
	test: {
		globals: true,
		environment: "node",
		// Browser suites start Vite servers and Chromium; serialize them and retain enough startup headroom on loaded hosts.
		testTimeout: 30000,
		fileParallelism: false,
	},
	resolve: {
		conditions: ["development", "browser"],
		alias: [{ find: /^solid-js\/web$/, replacement: "solid-js/web/dist/web.js" }],
	},
});
