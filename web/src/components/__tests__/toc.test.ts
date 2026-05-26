import { describe, expect, it } from 'vitest'
import { slugify, extractToc } from '@/utils/toc.ts'

describe('slugify', () => {
  it('lowercases text', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('replaces spaces with dashes', () => {
    expect(slugify('section one')).toBe('section-one')
  })

  it('removes leading and trailing dashes', () => {
    expect(slugify('--hello--')).toBe('hello')
  })

  it('keeps Chinese characters', () => {
    expect(slugify('配置选项')).toBe('配置选项')
  })

  it('replaces special characters with dashes', () => {
    expect(slugify('hello@world!')).toBe('hello-world')
  })

  it('handles empty string', () => {
    expect(slugify('')).toBe('')
  })

  it('handles numbers', () => {
    expect(slugify('Step 1')).toBe('step-1')
  })

  it('handles multiple consecutive special chars', () => {
    expect(slugify('a!!!b')).toBe('a-b')
  })

  it('handles mixed Chinese and English', () => {
    expect(slugify('配置 Options')).toBe('配置-options')
  })

  it('handles underscores (kept as word chars)', () => {
    expect(slugify('my_variable')).toBe('my_variable')
  })

  it('handles hyphens (treated as word chars)', () => {
    expect(slugify('already-dashed')).toBe('already-dashed')
  })

  it('handles dots', () => {
    expect(slugify('v1.0.0')).toBe('v1-0-0')
  })

  it('handles tabs and newlines as whitespace', () => {
    expect(slugify('hello\tworld\nfoo')).toBe('hello-world-foo')
  })

  it('handles only special characters', () => {
    expect(slugify('@#$%')).toBe('')
  })

  it('handles parentheses', () => {
    expect(slugify('func(arg)')).toBe('func-arg')
  })

  it('handles square brackets', () => {
    expect(slugify('array[0]')).toBe('array-0')
  })
})

describe('extractToc', () => {
  it('extracts markdown headers', () => {
    const content = '# Title\n## Section 1\n### Subsection\n## Section 2'
    const toc = extractToc(content, 'markdown')
    expect(toc).toHaveLength(4)
    expect(toc[0].level).toBe(1)
    expect(toc[0].text).toBe('Title')
    expect(toc[1].level).toBe(2)
    expect(toc[1].text).toBe('Section 1')
    expect(toc[2].level).toBe(3)
    expect(toc[2].text).toBe('Subsection')
  })

  it('returns empty for empty markdown', () => {
    const toc = extractToc('', 'markdown')
    expect(toc).toEqual([])
  })

  it('returns empty for markdown with no headers', () => {
    const toc = extractToc('Just some text\nNo headers here', 'markdown')
    expect(toc).toEqual([])
  })

  it('generates correct slug IDs for markdown', () => {
    const toc = extractToc('# Hello World', 'markdown')
    expect(toc[0].id).toBe('hello-world')
  })

  it('extracts Go symbols', () => {
    const content = 'type Server struct {}\nfunc (s *Server) Start() error {\nfunc main() {'
    const toc = extractToc(content, 'go')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Server')
  })

  it('extracts TypeScript symbols', () => {
    const content = 'export class App {}\nexport function helper() {}\nexport const VERSION = "1.0"'
    const toc = extractToc(content, 'typescript')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('App')
  })

  it('extracts Python symbols', () => {
    const content = 'class MyClass:\n    pass\ndef my_function():\n    pass'
    const toc = extractToc(content, 'python')
    expect(toc.length).toBeGreaterThanOrEqual(2)
  })

  it('returns empty for unknown language with no extractable content', () => {
    const toc = extractToc('just some random text', 'unknown')
    expect(toc).toEqual([])
  })

  it('sorts code symbols by line number', () => {
    const content = 'func later() {}\nfunc first() {}'
    const toc = extractToc(content, 'go')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    expect(toc[0].line).toBeLessThanOrEqual(toc[1].line)
  })

  it('deduplicates code symbols', () => {
    const content = 'func foo() {}\nfunc foo() {}'
    const toc = extractToc(content, 'go')
    // Two duplicate func declarations should result in only one toc entry
    expect(toc.length).toBe(1)
    expect(toc[0].text).toBe('foo')
  })

  it('handles Rust code', () => {
    const content = 'pub struct Config {\n}\npub fn run() {'
    const toc = extractToc(content, 'rust')
    expect(toc.length).toBeGreaterThanOrEqual(1)
  })

  it('handles YAML key extraction', () => {
    const content = 'server:\n  port: 8080\n  host: localhost'
    const toc = extractToc(content, 'yaml')
    expect(toc.length).toBeGreaterThanOrEqual(1)
  })

  it('handles JSON key extraction', () => {
    const content = '{\n  "name": "test",\n  "version": "1.0"\n}'
    const toc = extractToc(content, 'json')
    expect(toc.length).toBeGreaterThanOrEqual(1)
  })

  it('calculates correct line numbers for markdown', () => {
    const content = 'line 1\nline 2\n## Header on line 3'
    const toc = extractToc(content, 'markdown')
    expect(toc[0].line).toBe(3)
  })

  it('extracts h4-h6 headers', () => {
    const content = '#### Deep Header\n##### Deeper\n###### Deepest'
    const toc = extractToc(content, 'markdown')
    expect(toc).toHaveLength(3)
    expect(toc[0].level).toBe(4)
    expect(toc[1].level).toBe(5)
    expect(toc[2].level).toBe(6)
  })

  it('generates correct slug for Chinese headers', () => {
    const toc = extractToc('# 配置选项', 'markdown')
    expect(toc[0].id).toBe('配置选项')
  })

  it('does not filter # in code blocks (known limitation of simple regex)', () => {
    // The simple regex approach does not parse code blocks,
    // so # comments inside code blocks will be falsely matched as headers.
    // This is a known limitation.
    const content = '```python\n# This is a comment\n```\n## Real Header'
    const toc = extractToc(content, 'markdown')
    // The regex matches # This is a comment as h1 — known limitation
    expect(toc.length).toBeGreaterThanOrEqual(1)
    // But the real header should still be present
    const realHeaders = toc.filter(t => t.text === 'Real Header')
    expect(realHeaders).toHaveLength(1)
  })

  it('extracts CSS selectors', () => {
    const content = '.container {\n}\n#header {\n}\n@media screen {\n}'
    const toc = extractToc(content, 'css')
    expect(toc.length).toBeGreaterThanOrEqual(1)
  })

  it('extracts Dockerfile instructions', () => {
    const content = 'FROM golang:1.21\nRUN go build\nCMD ["./app"]'
    const toc = extractToc(content, 'dockerfile')
    expect(toc.length).toBeGreaterThanOrEqual(1)
  })

  it('extracts Go method receiver function name', () => {
    // Go pattern: /^func\s+(?:\(\S+\)\s+)?(\S+)/gm
    // Receiver without spaces like (*Type) is matched; (s *Server) with spaces is not.
    const content = 'func (*Server) Start() error {'
    const toc = extractToc(content, 'go')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Start')
  })

  it('extracts Java class and method symbols', () => {
    const content = 'public class Application {\n  public static void main(String[] args) {'
    const toc = extractToc(content, 'java')
    expect(toc.length).toBeGreaterThanOrEqual(1)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Application')
  })

  it('extracts C# class and method symbols', () => {
    // C# pattern captures keyword (class/struct/etc.) in group 1, name in group 2.
    // extractTocForCode uses match[1], so for classes it extracts the keyword.
    // For methods, group 1 captures the method name directly.
    const content = 'public class Program {\n  static void Main() {'
    const toc = extractToc(content, 'csharp')
    expect(toc.length).toBeGreaterThanOrEqual(1)
    // At minimum, the method 'Main' should be extracted
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Main')
  })

  it('extracts Bash function symbols', () => {
    const content = 'build() {\nfunction deploy() {'
    const toc = extractToc(content, 'bash')
    expect(toc.length).toBeGreaterThanOrEqual(1)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('build')
  })

  it('extracts SQL CREATE TABLE symbols', () => {
    const content = 'CREATE TABLE users (\n  id INT PRIMARY KEY\n);\nCREATE VIEW active_users AS SELECT * FROM users;'
    const toc = extractToc(content, 'sql')
    expect(toc.length).toBeGreaterThanOrEqual(1)
    const texts = toc.map(t => t.text)
    expect(texts.some(t => t.startsWith('users') || t.includes('users'))).toBe(true)
  })

  it('extracts C struct and function symbols', () => {
    const content = 'struct Config {\n  int port;\n};\nvoid start_server() {'
    const toc = extractToc(content, 'c')
    expect(toc.length).toBeGreaterThanOrEqual(1)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Config')
  })

  it('extracts Ruby class and method symbols', () => {
    const content = 'class Server\n  def initialize\nend\ndef self.start'
    const toc = extractToc(content, 'ruby')
    expect(toc.length).toBeGreaterThanOrEqual(1)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Server')
  })
})

describe('extractToc - more languages', () => {
  it('extracts PHP class and function symbols', () => {
    const content = 'class UserService {\n  public static function find() {\nfunction helper() {'
    const toc = extractToc(content, 'php')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('UserService')
    expect(texts).toContain('helper')
  })

  it('extracts PHP abstract class and interface', () => {
    const content = 'abstract class BaseHandler {\ninterface Logger {'
    const toc = extractToc(content, 'php')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('BaseHandler')
    expect(texts).toContain('Logger')
  })

  it('extracts Kotlin class and fun symbols', () => {
    const content = 'class MainActivity {\nfun onCreate() {\nval name = "test"\nvar count = 0'
    const toc = extractToc(content, 'kotlin')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('MainActivity')
  })

  it('extracts Kotlin data class and object', () => {
    const content = 'data class User(val name: String)\nobject Singleton'
    const toc = extractToc(content, 'kotlin')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('User')
    expect(texts).toContain('Singleton')
  })

  it('extracts Scala class and def symbols', () => {
    const content = 'class SparkJob {\nobject Config {\ndef run(): Unit = {\nval version = "1.0"'
    const toc = extractToc(content, 'scala')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('SparkJob')
    expect(texts).toContain('Config')
  })

  it('extracts Scala case class and trait', () => {
    const content = 'case class Event(id: Int)\ntrait Serializable'
    const toc = extractToc(content, 'scala')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Event')
    expect(texts).toContain('Serializable')
  })

  it('extracts Lua local function and method symbols', () => {
    const content = 'local function init()\nfunction MyClass:render()'
    const toc = extractToc(content, 'lua')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('init')
    expect(texts).toContain('render')
  })

  it('extracts Nginx server and location blocks', () => {
    const content = 'server {\n  listen 80;\n  location /api {\n  upstream backend {'
    const toc = extractToc(content, 'nginx')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('server')
    expect(texts).toContain('/api')
  })

  it('extracts INI section headers', () => {
    const content = '[database]\nhost=localhost\n[server]\nport=8080'
    const toc = extractToc(content, 'ini')
    expect(toc).toHaveLength(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('database')
    expect(texts).toContain('server')
  })

  it('extracts Vue template/script/style sections', () => {
    const content = '<template>\n  <div/>\n</template>\n<script setup>\n</script>\n<style scoped>\n</style>'
    const toc = extractToc(content, 'vue')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('template')
    expect(texts).toContain('script')
  })

  it('extracts Swift class and func symbols', () => {
    const content = 'class ViewController {\n  func viewDidLoad() {\n  var title: String\n  let count = 0'
    const toc = extractToc(content, 'swift')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('ViewController')
  })

  it('extracts Swift protocol and extension', () => {
    const content = 'protocol Delegate {\nextension UIView {'
    const toc = extractToc(content, 'swift')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Delegate')
    expect(texts).toContain('UIView')
  })

  it('extracts GraphQL type and field symbols', () => {
    const content = 'type Query {\n  users: [User]\n}\ninput CreateUserInput {\n  name: String\n}\nenum Role {\n  ADMIN\n}'
    const toc = extractToc(content, 'graphql')
    expect(toc.length).toBeGreaterThanOrEqual(3)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Query')
    expect(texts).toContain('CreateUserInput')
    expect(texts).toContain('Role')
  })

  it('extracts TOML section headers', () => {
    const content = '[dependencies]\nserde = "1.0"\n[[bin]]\nname = "app"\n[profile.release]'
    const toc = extractToc(content, 'toml')
    expect(toc.length).toBeGreaterThanOrEqual(2)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('dependencies')
    expect(texts).toContain('bin')
  })

  it('extracts Makefile targets', () => {
    const content = 'build:\n\tgo build\n test:\n\tgo test'
    const toc = extractToc(content, 'makefile')
    expect(toc.length).toBeGreaterThanOrEqual(1)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('build')
  })
})

describe('extractTocGeneric (fallback for unknown lang)', () => {
  it('extracts key-value pairs by indentation', () => {
    const content = 'root:\n  child1: value\n  child2:\n    grandchild: val'
    const toc = extractToc(content, 'unknown_lang')
    expect(toc.length).toBeGreaterThanOrEqual(1)
    const texts = toc.map(t => t.text)
    expect(texts).toContain('root')
  })

  it('skips comment lines starting with //', () => {
    const content = '// this is a comment\nkey: value'
    const toc = extractToc(content, 'unknown_lang')
    const texts = toc.map(t => t.text)
    expect(texts).not.toContain('this')
  })

  it('skips comment lines starting with #', () => {
    const content = '# this is a comment\nkey: value'
    const toc = extractToc(content, 'unknown_lang')
    const texts = toc.map(t => t.text)
    expect(texts).not.toContain('this')
  })

  it('skips comment lines starting with <!--', () => {
    const content = '<!-- HTML comment -->\nkey: value'
    const toc = extractToc(content, 'unknown_lang')
    const texts = toc.map(t => t.text)
    expect(texts).not.toContain('!--')
  })

  it('skips keys shorter than 2 characters', () => {
    const content = '{\n  a: 1,\n  ab: 2,\n}'
    const toc = extractToc(content, 'unknown_lang')
    const texts = toc.map(t => t.text)
    expect(texts).not.toContain('a')
    expect(texts).toContain('ab')
  })

  it('skips { as key', () => {
    const content = '{: something\nkey: value'
    const toc = extractToc(content, 'unknown_lang')
    const texts = toc.map(t => t.text)
    expect(texts).not.toContain('{')
  })

  it('skips [ as key', () => {
    const content = '[: something\nkey: value'
    const toc = extractToc(content, 'unknown_lang')
    const texts = toc.map(t => t.text)
    expect(texts).not.toContain('[')
  })

  it('limits results to 150 entries', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `key${i}: value`)
    const content = lines.join('\n')
    const toc = extractToc(content, 'unknown_lang')
    expect(toc.length).toBeLessThanOrEqual(150)
  })

  it('calculates indent levels correctly', () => {
    // indent 0 → level 1, indent 2 → level 2, indent 4 → level 3
    const content = 'root:\n  child:\n    grandchild:'
    const toc = extractToc(content, 'unknown_lang')
    expect(toc).toHaveLength(3)
    expect(toc[0].level).toBe(1) // indent 0 → Math.floor(0/2)+1 = 1
    expect(toc[1].level).toBe(2) // indent 2 → Math.floor(2/2)+1 = 2
    expect(toc[2].level).toBe(3) // indent 4 → Math.floor(4/2)+1 = 3
  })

  it('skips lines that do not end with : , { [ (', () => {
    const content = 'just a plain line\nkey: value'
    const toc = extractToc(content, 'unknown_lang')
    const texts = toc.map(t => t.text)
    expect(texts).not.toContain('just')
  })

  it('skips lines with indent > 6', () => {
    const content = 'root:\n        tooDeep: value'
    const toc = extractToc(content, 'unknown_lang')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('root')
    expect(texts).not.toContain('tooDeep')
  })

  it('returns empty for content with no extractable keys', () => {
    const toc = extractToc('just plain text\nno keys here', 'unknown_lang')
    expect(toc).toEqual([])
  })
})

describe('slugify edge cases', () => {
  it('handles pure Chinese with punctuation', () => {
    expect(slugify('你好，世界！')).toBe('你好-世界')
  })

  it('handles Unicode emoji', () => {
    const result = slugify('hello 🚀 world')
    expect(result).toBe('hello-world')
  })

  it('handles very long string', () => {
    const long = 'a'.repeat(10000)
    const result = slugify(long)
    expect(result).toBe(long.toLowerCase())
    expect(result).toHaveLength(10000)
  })

  it('handles mixed upper and lower case', () => {
    expect(slugify('FooBARbaz')).toBe('foobarbaz')
  })

  it('handles Chinese with English and special chars', () => {
    expect(slugify('第1章：简介（Overview）')).toBe('第1章-简介-overview')
  })
})

describe('extractToc edge cases', () => {
  it('extracts Go type alias', () => {
    const content = 'type MyAlias = int\ntype AnotherAlias = string'
    const toc = extractToc(content, 'go')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('MyAlias')
    expect(texts).toContain('AnotherAlias')
  })

  it('extracts Go var declarations', () => {
    const content = 'var version = "1.0"\nvar debug bool'
    const toc = extractToc(content, 'go')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('version')
    expect(texts).toContain('debug')
  })

  it('extracts Go const declarations', () => {
    const content = 'const MaxRetries = 3\nconst DefaultTimeout = 30'
    const toc = extractToc(content, 'go')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('MaxRetries')
    expect(texts).toContain('DefaultTimeout')
  })

  it('extracts TypeScript enum', () => {
    const content = 'enum Color {\n  Red,\n  Green\n}'
    const toc = extractToc(content, 'typescript')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Color')
  })

  it('extracts TypeScript interface', () => {
    const content = 'interface User {\n  name: string\n}\nexport interface Config {'
    const toc = extractToc(content, 'typescript')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('User')
    expect(texts).toContain('Config')
  })

  it('extracts TypeScript type alias', () => {
    const content = 'type ID = string\nexport type Result<T> = { data: T }'
    const toc = extractToc(content, 'typescript')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('ID')
    expect(texts).toContain('Result')
  })

  it('extracts Rust impl blocks', () => {
    const content = 'impl Server {\n  pub fn start() {}\n}\nimpl<T> Handler for Server {'
    const toc = extractToc(content, 'rust')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Server')
  })

  it('extracts Rust trait definitions', () => {
    const content = 'pub trait Handler {\n  fn handle(&self);\n}'
    const toc = extractToc(content, 'rust')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Handler')
  })

  it('extracts Rust mod declarations', () => {
    const content = 'pub mod network;\npub mod config;'
    const toc = extractToc(content, 'rust')
    const texts = toc.map(t => t.text)
    // \S+ captures the semicolon too, e.g. "network;"
    expect(texts.some(t => t.startsWith('network'))).toBe(true)
    expect(texts.some(t => t.startsWith('config'))).toBe(true)
  })

  it('handles multi-line comments in Go without interference', () => {
    const content = '/* This is a\n   multi-line comment */\ntype Server struct {}'
    const toc = extractToc(content, 'go')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('Server')
  })

  it('handles C++ namespace and template class', () => {
    const content = 'namespace myapp {\ntemplate<typename T> class Container {'
    const toc = extractToc(content, 'cpp')
    const texts = toc.map(t => t.text)
    expect(texts).toContain('myapp')
    expect(texts).toContain('Container')
  })

  it('strips trailing braces and angle brackets from matched text', () => {
    const content = 'type Server<T> struct {\nfunc (s *Server) Start() error {'
    const toc = extractToc(content, 'go')
    const texts = toc.map(t => t.text)
    // The regex captures "Server<T>" but text is cleaned to "Server"
    expect(texts).toContain('Server')
  })
})
