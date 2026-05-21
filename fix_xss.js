const fs = require('fs');
let c = fs.readFileSync('admin.html', 'utf8');

if (!c.includes('const esc = s =>')) {
  c = c.replace('<script>', `<script>
    const esc = s => typeof s === 'string' 
      ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;') 
      : (s == null ? '' : s);`);
}

c = c.replace(/\$\{item\.([a-zA-Z0-9_]+)( \|\| [^\}]+)?\}/g, (match, p1, p2) => {
    // Only wrap strings that look like they could be untrusted text.
    // E.g., item.name, item.message, item.email, item.subject, item.customer_name
    const p2Str = p2 || '';
    return `\${esc(item.${p1}${p2Str})}`;
});

fs.writeFileSync('admin.html', c);
console.log('Fixed XSS in admin.html');
