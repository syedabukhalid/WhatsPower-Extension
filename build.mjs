import ts from 'typescript';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(projectRoot, 'src');
const distRoot = path.join(projectRoot, 'dist');
const entryPoints = {
  'background/background': 'src/background/background.ts',
  'content/main-world': 'src/content/main-world.ts',
  'content/isolated-world': 'src/content/isolated-world.ts',
  'popup/popup': 'src/popup/popup.ts'
};

async function findTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTypeScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(fullPath);
  }
  return files;
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });

const sourceFiles = await findTypeScriptFiles(sourceRoot);
const modules = {};
for (const filePath of sourceFiles) {
  const relativeId = path.relative(projectRoot, filePath).replaceAll(path.sep, '/').replace(/\.ts$/, '');
  const sourceText = await readFile(filePath, 'utf8');
  const result = ts.transpileModule(sourceText, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      strict: true,
      esModuleInterop: true,
      removeComments: false
    }
  });
  const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    const formatted = errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n');
    throw new Error(`TypeScript transpilation failed for ${relativeId}:\n${formatted}`);
  }
  modules[relativeId] = result.outputText;
}

function makeBundle(entryId) {
  const reachable = new Set();
  const resolveModuleId = (from, request) => path.posix.normalize(
    path.posix.join(path.posix.dirname(from), request)
  ).replace(/\.js$/, '');
  function visit(id) {
    if (reachable.has(id)) return;
    const code = modules[id];
    if (code === undefined) throw new Error(`Missing imported TypeScript module: ${id}`);
    reachable.add(id);
    const requires = code.matchAll(/require\(["']([^"']+)["']\)/g);
    for (const match of requires) visit(resolveModuleId(id, match[1]));
  }
  visit(entryId);
  const moduleDefinitions = [...reachable].map((id) => {
    const code = modules[id];
    return `${JSON.stringify(id)}: function(require, module, exports) {\n${code}\n}`;
  }).join(',\n');
  return `/* Whatspower generated bundle. Edit src/ files, not dist/. */\n` +
`(function () {\n` +
`  'use strict';\n` +
`  const factories = {\n${moduleDefinitions}\n  };\n` +
`  const cache = Object.create(null);\n` +
`  function resolve(from, request) {\n` +
`    const base = from.split('/').slice(0, -1);\n` +
`    for (const part of request.split('/')) {\n` +
`      if (!part || part === '.') continue;\n` +
`      if (part === '..') base.pop(); else base.push(part);\n` +
`    }\n` +
`    return base.join('/').replace(/\\.js$/, '');\n` +
`  }\n` +
`  function load(id) {\n` +
`    if (cache[id]) return cache[id].exports;\n` +
`    const factory = factories[id];\n` +
`    if (!factory) throw new Error('Whatspower bundle module not found: ' + id);\n` +
`    const module = { exports: {} };\n` +
`    cache[id] = module;\n` +
`    const localRequire = (request) => load(resolve(id, request));\n` +
`    factory(localRequire, module, module.exports);\n` +
`    return module.exports;\n` +
`  }\n` +
`  load(${JSON.stringify(entryId)});\n` +
`})();\n`;
}

for (const [outputName, sourcePath] of Object.entries(entryPoints)) {
  const entryId = sourcePath.replace(/\.ts$/, '');
  const outputPath = path.join(distRoot, `${outputName}.js`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, makeBundle(entryId), 'utf8');
}

await mkdir(path.join(distRoot, 'popup'), { recursive: true });
await cp(path.join(sourceRoot, 'popup', 'popup.html'), path.join(distRoot, 'popup', 'popup.html'));
await cp(path.join(sourceRoot, 'popup', 'popup.css'), path.join(distRoot, 'popup', 'popup.css'));

console.log('Whatspower build completed. Load this project folder as an unpacked extension.');
