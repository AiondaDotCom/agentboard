import tseslint from 'typescript-eslint';

// REST API payloads, DB rows and MCP tool arguments are snake_case by design
// (blocked_reason, depends_on, work_type, assignee_id, ...). Destructuring them
// keeps the wire names, so destructured bindings may be snake_case. Unused
// parameters may carry a leading underscore (`_req`, `_`) – the usual way to
// mark a positional parameter that has to exist but is not read.
const namingConvention = [
  'error',
  { selector: 'variableLike', format: ['camelCase', 'UPPER_CASE'] },
  { selector: 'parameter', modifiers: ['unused'], format: ['camelCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },
  { selector: ['variable', 'parameter'], modifiers: ['destructured'], format: ['camelCase', 'snake_case'] },
  { selector: 'typeLike', format: ['PascalCase'] },
  { selector: 'enumMember', format: ['UPPER_CASE'] },
];

export default tseslint.config(
  {
    ignores: ['dist/', 'public/', 'node_modules/', '*.config.*'],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      // Numbers in template literals (counts, limits, ports) stringify
      // unambiguously; everything else (objects, nullish, any, ...) stays forbidden.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `const { secret, ...rest } = obj` is the idiomatic way to omit a property.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      '@typescript-eslint/naming-convention': namingConvention,
      // Contradicts no-non-null-assertion (strict): it rewrites `x as T` to
      // `x!`, which is forbidden. Explicit `as T` stays the allowed form.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
    },
  },
  {
    // Tests are not part of the build tsconfig (rootDir ./src), so there is no
    // type information for them: lint them with the syntactic rules only.
    files: ['tests/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // naming-convention works without type information – keep it.
      '@typescript-eslint/naming-convention': namingConvention,
      // Tests assert presence right before dereferencing (`find(...)!.id`);
      // a failing assertion is the desired outcome there.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
