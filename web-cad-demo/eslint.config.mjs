import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // .cjs runners intentionally use Node's CommonJS module mechanism.
  { files: ["scripts/**/*.cjs"], languageOptions: { sourceType: "commonjs" }, rules: { "@typescript-eslint/no-require-imports": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    ".artifacts/**",
    ".releases/**",
    ".backend-releases/**",
    ".wrangler/**",
    "runtime-logs/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
