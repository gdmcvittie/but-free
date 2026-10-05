const fs = require('fs');
const path = require('path');

const src = 'C:\\Users\\yifna\\.gemini\\antigravity-ide\\brain\\4bb77b88-8636-4147-81b9-9ef558964771\\fraudio_app_icon_1791054128607.jpg';
const destDir = path.resolve(__dirname, '..', 'mobile-client', 'app', 'src', 'main', 'res', 'drawable');

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, path.join(destDir, 'ic_launcher.png'));
fs.copyFileSync(src, path.join(destDir, 'icon_512.png'));
fs.copyFileSync(src, path.join(destDir, 'icon_192.png'));
console.log('Icons copied successfully to', destDir);
