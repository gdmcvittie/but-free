import fs from 'fs';
import path from 'path';

const file1 = 'C:/_code/___MY-TV/cloud-only/server/server.js';
const file2 = 'c:/_code/but-free/tv/server/server.js';

const a = fs.readFileSync(file1, 'utf8').split('\n');
const b = fs.readFileSync(file2, 'utf8').split('\n');

console.log(`Server lines: A=${a.length}, B=${b.length}`);

// Find blocks of diffs
// Let's write diff report
const out = [];

// Simple LCS or line diff for blocks
// Let's check sections by function name or route
const routesA = [];
const routesB = [];
a.forEach((line, i) => {
  if (line.includes('app.get(') || line.includes('app.post(') || line.includes('app.all(') || line.includes('function ') || line.includes('const HLS_')) {
    routesA.push({ line: i + 1, text: line.trim() });
  }
});
b.forEach((line, i) => {
  if (line.includes('app.get(') || line.includes('app.post(') || line.includes('app.all(') || line.includes('function ') || line.includes('const HLS_')) {
    routesB.push({ line: i + 1, text: line.trim() });
  }
});

fs.writeFileSync('c:/_code/but-free/scripts/diff_routes_A.json', JSON.stringify(routesA, null, 2));
fs.writeFileSync('c:/_code/but-free/scripts/diff_routes_B.json', JSON.stringify(routesB, null, 2));

console.log(`Routes/functions count: A=${routesA.length}, B=${routesB.length}`);
