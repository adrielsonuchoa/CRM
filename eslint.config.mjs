import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "tmp/**",
    ".test-*.ts",
    ".tmp-*.ts",
    // dist/ e o pacote final gerado por scripts/prepare-client-installer.ps1
    // (build compilado + node_modules do cliente) - nao e codigo-fonte, so
    // ".next/**" acima nao cobre porque aqui fica aninhado (dist/<cliente>/.next/**).
    "dist/**",
  ]),
]);

export default eslintConfig;
