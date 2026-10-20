/* 打包脚本：node build.js
 * 把 styles.css / app.js / ai.js / vendor/xlsx.full.min.js 内联进 SheetPilot.html
 * 源文件改动后重新运行本脚本即可生成新的单文件版。
 */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

let html = read('index.html');

const parts = [
  ['<link rel="stylesheet" href="styles.css" />', read('styles.css'), 'style'],
  ['<script src="vendor/xlsx.full.min.js"></script>', read('vendor/xlsx.full.min.js'), 'script'],
  ['<script src="app.js"></script>', read('app.js'), 'script'],
  ['<script src="ai.js"></script>', read('ai.js'), 'script'],
];

for (const [needle, content, tag] of parts) {
  if (!html.includes(needle)) throw new Error('index.html 中找不到占位标记：' + needle);
  // 内联内容里若出现闭合标签会截断文档，直接报错
  if (new RegExp('</' + tag, 'i').test(content)) throw new Error(`${tag} 内容中含有 </${tag}>，无法安全内联`);
  html = html.replace(needle, () => `<${tag}>\n${content}\n</${tag}>`);
}

if (!html.includes('<title>')) throw new Error('index.html 缺少 <title>');
html = html.replace('<title>', '<title>单文件版 · ');

if (/<script src=|<link[^>]+stylesheet/i.test(html)) throw new Error('仍有未内联的外部引用');

const out = path.join(dir, 'SheetPilot.html');
fs.writeFileSync(out, html, 'utf8');
console.log('已生成 SheetPilot.html ·', (fs.statSync(out).size / 1024 / 1024).toFixed(2) + ' MB');
