import fs from 'node:fs';
import path from 'node:path';

const brsPath = path.resolve('tv/roku/components/MainScene.brs');
const brsContent = fs.readFileSync(brsPath, 'utf8');
const brsLines = brsContent.split(/\r?\n/);
let errors = [];
let stack = [];

for (let i = 0; i < brsLines.length; i++) {
  const lineNo = i + 1;
  let line = brsLines[i];

  let stripped = '';
  let inStr = false;
  for (let c = 0; c < line.length; c++) {
    if (line[c] === '"') {
      inStr = !inStr;
      stripped += ' ';
    } else if (!inStr) {
      stripped += line[c];
    } else {
      stripped += ' ';
    }
  }
  if (inStr) {
    errors.push(`Line ${lineNo}: Unclosed string literal: ${line.trim()}`);
  }

  const remPos = stripped.indexOf("'");
  if (remPos >= 0) stripped = stripped.substring(0, remPos);
  const remKeyPos = stripped.search(/\brem\b/i);
  if (remKeyPos >= 0) stripped = stripped.substring(0, remKeyPos);

  const trimmed = stripped.trim();
  if (!trimmed) continue;
  const lower = trimmed.toLowerCase();

  if (/^sub\s+\w+/i.test(lower)) {
    stack.push({ type: 'sub', line: lineNo, text: trimmed });
  } else if (/^function\s+\w+/i.test(lower)) {
    stack.push({ type: 'function', line: lineNo, text: trimmed });
  } else if (/^end\s+sub\b/i.test(lower)) {
    const top = stack.pop();
    if (!top || top.type !== 'sub') {
      errors.push(`Line ${lineNo}: 'end sub' without matching 'sub' (found: ${top ? top.type + ' at line ' + top.line : 'none'})`);
    }
  } else if (/^end\s+function\b/i.test(lower)) {
    const top = stack.pop();
    if (!top || top.type !== 'function') {
      errors.push(`Line ${lineNo}: 'end function' without matching 'function' (found: ${top ? top.type + ' at line ' + top.line : 'none'})`);
    }
  } else if (/^if\b/i.test(lower)) {
    const thenMatch = lower.match(/\bthen\b/i);
    if (thenMatch) {
      const afterThen = trimmed.substring(thenMatch.index + 4).trim();
      if (!afterThen) {
        stack.push({ type: 'if', line: lineNo, text: trimmed });
      }
    } else {
      if (/\b(return|goto|print)\b/i.test(lower)) {
        // single-line if statement
      } else {
        stack.push({ type: 'if', line: lineNo, text: trimmed });
      }
    }
  } else if (/^end\s+if\b/i.test(lower)) {
    const top = stack.pop();
    if (!top || top.type !== 'if') {
      errors.push(`Line ${lineNo}: 'end if' without matching 'if' (found: ${top ? top.type + ' at line ' + top.line : 'none'})`);
    }
  } else if (/^while\b/i.test(lower)) {
    stack.push({ type: 'while', line: lineNo, text: trimmed });
  } else if (/^end\s+while\b/i.test(lower)) {
    const top = stack.pop();
    if (!top || top.type !== 'while') {
      errors.push(`Line ${lineNo}: 'end while' without matching 'while' (found: ${top ? top.type + ' at line ' + top.line : 'none'})`);
    }
  } else if (/^for\b/i.test(lower)) {
    stack.push({ type: 'for', line: lineNo, text: trimmed });
  } else if (/^(end\s+for|next)\b/i.test(lower)) {
    const top = stack.pop();
    if (!top || top.type !== 'for') {
      errors.push(`Line ${lineNo}: 'end for/next' without matching 'for' (found: ${top ? top.type + ' at line ' + top.line : 'none'})`);
    }
  }
}

if (stack.length > 0) {
  for (const s of stack) {
    errors.push(`Unclosed '${s.type}' opened at line ${s.line}: ${s.text}`);
  }
}

if (errors.length > 0) {
  console.error('\n❌ BrightScript Syntax Errors detected:');
  for (const err of errors) console.error('  • ' + err);
  process.exit(1);
} else {
  console.log(`✓ MainScene.brs syntax validated cleanly (${brsLines.length} lines)`);
  process.exit(0);
}
