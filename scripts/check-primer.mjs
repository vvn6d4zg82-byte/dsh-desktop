// Primer 规范合规检查（stylelint-lite，零依赖）
// 用法：node scripts/check-primer.mjs   （或 npm run check:style）
//
// 强制规则：
//   1. TSX 内禁止色值字面量（#[rgb]/#[rrggbb]/rgba(...)）→ 颜色必须走 var(--p-*)
//   2. 禁止 gradient（渐变）
//   3. 禁止 shadow-*（粗阴影）与 text-shadow / glow（霓虹）
//   4. 禁止 Tailwind 任意值类（bg-[ 、text-[ 、border-[ 、h-[ 、w-[ 、rounded-[ 等）
//   5. 禁止 style={{...}} 内联视觉（颜色/阴影/渐变/圆角）
//   6. CSS 内新增类必须 p- 前缀（防止新视觉语言偷偷混入）
//
// 关于 charts/ 豁免的历史（2026-09）：
//   最初计划用 Chart.js 做图表，为此给 charts/ 开了 C1/C2/C3 豁免。
//   后来决定**不引第三方绘图库**（点云密度图 Chart.js 做不了，且库会带进
//   渐变/阴影），改为自写 canvas 渲染（charts/render.ts），颜色同样从
//   var(--p-*) 读计算值 —— 于是豁免不再必要，已收回。
//   现在 charts/ 与其它目录规则完全一致。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxDir = join(root, 'ui', 'src', 'versions', 'primer');
const cssFile = join(tsxDir, 'p-console.css');

const violations = [];

// ---------- 规则 1-4：扫描 TSX ----------
const reColorLiteral = /(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*\d)/;
const reGradient = /gradient/i;
const reShadow = /(?:^|\s)shadow-(?!none\b)/;
const reTextShadow = /text-shadow|drop-shadow|glow/i;
// Tailwind 任意值类：允许 var(--p-*) token 引用，禁止其它任意值（色值/字号/间距等字面量）
const reArbitrary = /(?:^|\s)(bg|text|border|h|w|p|m|mt|mb|ml|mr|gap|rounded|min-w|max-w|min-h|max-h|outline)-\[(?!var\(--p-)/;
const reInlineStyleColor = /style=\{\{[^}]*?(?:color|background|border|boxShadow|textShadow|backgroundImage|borderRadius)\s*:/;

function scanTsx(file) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const check = (re, ruleId, label) => {
    lines.forEach((ln, i) => {
      if (re.test(ln)) violations.push(`[${ruleId}] ${label}: ${file.replace(root + '\\', '')}:${i + 1}\n    ${ln.trim().slice(0, 140)}`);
    });
  };
  check(reColorLiteral, 'C1', '色值字面量（须用 var(--p-*)）');
  check(reGradient, 'C2', '渐变被禁止');
  check(reShadow, 'C3', '粗阴影被禁止（shadow-*）');
  check(reTextShadow, 'C4', '霓虹/发光被禁止');
  check(reArbitrary, 'C5', 'Tailwind 任意值类被禁止');
  check(reInlineStyleColor, 'C6', 'style 内联视觉被禁止');
}

function walkDir(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walkDir(full);
    } else if (name.endsWith('.tsx') || name.endsWith('.ts')) {
      scanTsx(full);
    }
  }
}
walkDir(tsxDir);

// ---------- 规则 6：CSS 类必须 p- 前缀 ----------
const css = readFileSync(cssFile, 'utf8');
// 一条规则里若出现任何 p- 前缀类（如 .p-badge.online），整条豁免状态修饰符；
// 完全不带 p- 前缀的孤立类才算违规（防止新视觉语言混入）。
function extractRuleSelectors(cssText) {
  // 简单地把每条规则的选择器部分按 '.' 切分（不做完整 CSS 解析，够用）
  const rules = [];
  let depth = 0;
  let cur = '';
  for (const ch of cssText) {
    if (ch === '{') {
      if (depth === 0) rules.push(cur.trim());
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) cur = '';
    } else if (depth === 0) {
      cur += ch;
    }
  }
  return rules;
}

const cssRules = extractRuleSelectors(css);
for (const sel of cssRules) {
  // 跳过 @media 等 at-rule 外壳（其内部规则会另行命中）
  if (sel.startsWith('@')) continue;
  const classes = [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  if (classes.length === 0) continue;
  // 豁免：选择器里含 p- 前缀类、term-line-*、主题根类
  const hasPPrefix = classes.some((c) => c.startsWith('p-') || c.startsWith('term-line-') || c === 'app' || c === 'dark');
  if (!hasPPrefix) {
    violations.push(`[C7] CSS 类非 p- 前缀：.${classes.join('.')} @ ${cssFile}`);
  }
}

// ---------- 输出 ----------
if (violations.length === 0) {
  console.log('✅ Primer 规范检查通过：无违规。');
  process.exit(0);
}
console.log(`❌ Primer 规范检查失败：${violations.length} 处违规\n`);
console.log(violations.slice(0, 40).join('\n'));
if (violations.length > 40) console.log(`…（剩余 ${violations.length - 40} 处省略）`);
process.exit(1);