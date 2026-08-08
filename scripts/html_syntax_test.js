const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = ['index.html', ...fs.readdirSync('pages').filter(name => name.endsWith('.html')).map(name => path.join('pages', name))];
let count = 0;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(code => code.trim());
  scripts.forEach((code, index) => {
    try { new vm.Script(code, {filename: `${file}:inline-${index + 1}`}); }
    catch (error) { throw new Error(`${file} inline script ${index + 1}: ${error.message}`); }
    count += 1;
  });
}
console.log(`html syntax test ok: ${files.length} pages; ${count} inline scripts`);
