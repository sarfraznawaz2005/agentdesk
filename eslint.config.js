import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
	// Global ignores
	{
		ignores: ["node_modules/**", "dist/**", "build/**", "drizzle/**", ".beans/**"],
	},

	// Base JS recommended rules
	js.configs.recommended,

	// TypeScript strict rules for all TS files
	...tseslint.configs.strict,

	// Configuration for all TypeScript source files
	{
		files: ["src/**/*.{ts,tsx}"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"no-unused-vars": "off", // Handled by @typescript-eslint/no-unused-vars
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-explicit-any": "warn",
		},
	},

	// React-specific configuration for mainview (browser) files
	{
		files: ["src/mainview/**/*.{ts,tsx}"],
		plugins: {
			"react-hooks": reactHooks,
			"react-refresh": reactRefresh,
		},
		rules: {
			...reactHooks.configs.recommended.rules,
			"react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
		},
	},

	// Bun-side configuration — relax rules for Node/Bun-specific imports
	{
		files: ["src/bun/**/*.{ts,tsx}"],
		rules: {
			// electrobun/bun and bun:sqlite are valid Bun/Electrobun module specifiers
			"@typescript-eslint/no-require-imports": "off",
		},
	},
);
