import ts from 'typescript'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import vi from '../src/locales/vi.json'

const catalog: Record<string, string> = vi
const used = new Set<string>()
const candidates: object[] = []
let failures = 0
function scan(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) { scan(file); continue }
    if (!/\.tsx?$/.test(file)) continue
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const aliases = new Set<string>()
    for (const node of ast.statements) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /\/i18n$/.test(node.moduleSpecifier.text)) {
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
          if ((item.propertyName?.text ?? item.name.text) === 't') aliases.add(item.name.text)
        }
      }
    }
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) {
        const key = node.arguments[0]
        if (!key || !ts.isStringLiteral(key) || !Object.hasOwn(catalog, key.text)) {
          console.error(`${file}: missing or dynamic translation key`); failures++
        } else used.add(key.text)
      }
      if (file.endsWith('.tsx') && (ts.isStringLiteral(node) || ts.isJsxText(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
        const value = node.text.trim()
        if (value) {
          const parent = node.parent
          const visible = ts.isJsxText(node) || (ts.isJsxAttribute(parent) && ['title', 'placeholder', 'aria-label', 'label'].includes(parent.name.getText(ast)))
          candidates.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, value,
            classification: visible ? 'display-review' : 'context-review (identifier/API/command/data excluded unless display-only)' })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
}
scan('src')
for (const [key, value] of Object.entries(catalog)) if (!value.trim()) { console.error(`Empty: ${key}`); failures++ }
writeFileSync('audit/codex-sol-recovery/localization-candidates.json', JSON.stringify(candidates, null, 2) + '\n')
console.log(JSON.stringify({ catalog: Object.keys(catalog).length, referenced: used.size, unused: Object.keys(catalog).filter(key => !used.has(key)), candidates: candidates.length, failures }, null, 2))
process.exitCode = failures ? 1 : 0
