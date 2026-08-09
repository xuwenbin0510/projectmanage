// @ts-check
/**
 * ESLint flat config · 太空字节 PM 系统前端
 *
 * 依赖（均已在 devDependencies 中声明，未引入任何新依赖）：
 *   - eslint            ^10.8.1
 *   - @eslint/js        ^10.0.1
 *   - typescript-eslint ^8.66.0
 *   - globals           ^17.9.0
 *
 * 说明：package.json 含 "type": "module"，故使用 ESM `export default`。
 * 不引入 eslint-plugin-react / eslint-plugin-react-hooks —— 二者与 eslint 10
 * 的 peer 约束不兼容；typescript-eslint 的 parser 已能完整解析 .tsx 语法。
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * react-hooks 兼容占位插件。
 *
 * 存量代码中有 14 处 `// eslint-disable-next-line react-hooks/exhaustive-deps`
 * 注释（依赖数组有意收窄，属既有设计）。由于本项目未安装 eslint-plugin-react-hooks
 * （与 eslint 10 peer 不兼容，且本轮硬约束禁止新增依赖），这些注释会触发
 * "Definition for rule 'react-hooks/exhaustive-deps' was not found" 错误。
 *
 * 这里注册同名 no-op 规则占位，使 disable 指令可被正常解析。
 * 规则本身不做任何检查——待后续升级到兼容版插件后，替换此占位即可恢复真实校验。
 * 该方案为纯配置层处理，不改动任何源码注释。
 */
const reactHooksCompat = {
  rules: {
    'exhaustive-deps': { meta: { schema: [] }, create: () => ({}) },
    'rules-of-hooks': { meta: { schema: [] }, create: () => ({}) },
  },
};

export default tseslint.config(
  // 1) 全局忽略：构建产物 / 缓存 / 历史遗留目录
  //    （node_modules 由 ESLint 默认忽略，此处显式列出仅为可读性）
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.cache/**',
      'legacy/**',
      '**/*.tsbuildinfo',
    ],
  },

  // 2) TypeScript / TSX 源码
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      'react-hooks': reactHooksCompat,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      // 占位规则永不报告，会令上述 disable 指令被判定为「未使用」并刷屏告警，故关闭该检查
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // 存量大量 any（mock 引擎 / 动态表单），关闭以避免噪声淹没真实问题
      '@typescript-eslint/no-explicit-any': 'off',
      // 非空断言在 MUI ref / DOM 取值处普遍使用，关闭
      '@typescript-eslint/no-non-null-assertion': 'off',
      // 用 TS 版本替代基础版，避免对 type / interface / 泛型参数误报
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      // console 保留为 warn：不阻断 CI，但持续暴露调试残留
      'no-console': 'warn',
      // 存量代码惯用「防御性初始值」（如 `let x: T | null = null` 后在 try/catch 双分支赋值），
      // 该写法本身安全且更抗未来分支遗漏；降级为 warn，避免为纯风格问题改动运行时代码
      'no-useless-assignment': 'warn',
      // 存量空 catch / 空分支多为有意吞异常，关闭
      'no-empty': 'off',
      // 其余保持 js/tseslint recommended 默认
    },
  },

  // 3) 类型声明文件：ambient interface（如 ImportMeta / Window 增强）
  //    会被 no-unused-vars 误判为未使用，此处关闭
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // 4) 受保护的引擎 / 核心规则文件：本轮禁止改动其内容，
  //    故将未用变量降级为 warn，避免因无法清理而阻断 lint
  {
    files: ['src/api/mock/**/*.ts', 'src/utils/wbs.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
);
