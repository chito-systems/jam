import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees; without this every agent's
    // copy of the suite runs too.
    exclude: [...configDefaults.exclude, ".claude/**", "cnh-scaffold/**"],
  },
});
