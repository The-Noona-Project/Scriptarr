import jsdoc from "eslint-plugin-jsdoc";

const sharedGlobals = Object.freeze({
  AbortSignal: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly"
});

export default [
  {
    files: [
      "services/warden/**/*.mjs",
      "services/sage/**/*.mjs"
    ],
    plugins: {
      jsdoc
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: sharedGlobals
    },
    rules: {
      "jsdoc/check-param-names": "error",
      "jsdoc/check-tag-names": "error",
      "jsdoc/require-file-overview": [
        "error",
        {
          tags: {
            file: {
              initialCommentsOnly: true
            }
          }
        }
      ],
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: {
            ancestorsOnly: false,
            esm: true
          },
          require: {
            ArrowFunctionExpression: true,
            ClassDeclaration: true,
            FunctionDeclaration: true,
            FunctionExpression: true,
            MethodDefinition: true
          }
        }
      ]
    }
  }
];
