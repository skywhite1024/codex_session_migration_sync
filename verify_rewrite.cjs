// 等价复刻 path_rewrite.rs 的 apply_line 算法，跑行为验证。
// 保持与 Rust 实现完全相同的规则：原始形式 + JSON 转义形式双匹配，边界保护。
const EOL = "\n";

function escapeJsonPath(p) { return p.replace(/\\/g, "\\\\"); }

function compile(rw) {
  const from = rw.from.trimEnd().replace(/[\/\\]+$/, "");
  return {
    fromRaw: from,
    fromJson: escapeJsonPath(from),
    toRaw: rw.to,
    toJson: escapeJsonPath(rw.to),
  };
}

function boundaryOk(rest) {
  if (rest.length === 0) return true;
  const c = rest[0];
  return "/\\ \"\t\r.)".includes(c);
}

function applyLine(line, rules) {
  if (!rules.length) return line;
  let out = "";
  let rest = line;
  while (true) {
    let best = null;
    for (const r of rules) {
      const candidates = [
        [rest.indexOf(r.fromJson), true, r.fromJson.length],
        [rest.indexOf(r.fromRaw), false, r.fromRaw.length],
      ];
      for (const [idx, isJson, len] of candidates) {
        if (idx < 0) continue;
        if (!boundaryOk(rest.slice(idx + len))) continue;
        if (!best || idx < best.idx) best = { idx, r, isJson };
      }
    }
    if (!best) { out += rest; return out; }
    out += rest.slice(0, best.idx);
    const consumed = best.isJson ? best.r.fromJson.length : best.r.fromRaw.length;
    out += best.isJson ? best.r.toJson : best.r.toRaw;
    rest = rest.slice(best.idx + consumed);
  }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name, detail || ""); }
}

console.log("1. Windows JSON-escaped cwd rewrite");
{
  const line = '{"type":"session_meta","payload":{"id":"s1","cwd":"C:\\\\Users\\\\alex\\\\proj","v":1}}';
  const out = applyLine(line, [compile({ from: "C:\\Users\\alex\\proj", to: "D:\\work\\proj" })]);
  check("cwd replaced", out.includes('"cwd":"D:\\\\work\\\\proj"'), out);
}

console.log("2. Does not touch look-alike prefixes");
{
  const line = '{"cwd":"C:\\\\proj-other\\\\src"}';
  const out = applyLine(line, [compile({ from: "C:\\proj", to: "D:\\new" })]);
  check("proj-other untouched", out.includes("proj-other") && !out.includes("D:\\\\new"), out);
}

console.log("3. POSIX paths, two occurrences, tail kept");
{
  const line = '{"cwd":"/Users/alex/proj"} {"cmd":"cd /Users/alex/proj/src && ls"}';
  const out = applyLine(line, [compile({ from: "/Users/alex/proj", to: "/srv/proj" })]);
  const count = out.split("/srv/proj").length - 1;
  check("two replacements", count === 2, out);
  check("tail kept", out.includes("/srv/proj/src"), out);
}

console.log("4. Trailing slash in `from` tolerated");
{
  const line = '{"cwd":"/Users/alex/proj/"}';
  const out = applyLine(line, [compile({ from: "/Users/alex/proj/", to: "/srv/proj" })]);
  check("trailing slash normalized", out.includes('"/srv/proj/"'), out);
}

console.log("5. Empty rules = identity");
{
  const line = '{"cwd":"/Users/alex/proj"}';
  check("identity", applyLine(line, []) === line);
}

console.log("6. Multiple rules, earliest wins");
{
  const line = '{"a":"/Users/alex/proj/x","b":"/Users/bob/work/y"}';
  const out = applyLine(line, [
    compile({ from: "/Users/bob/work", to: "/srv/bob" }),
    compile({ from: "/Users/alex/proj", to: "/srv/alex" }),
  ]);
  check("both replaced", out.includes("/srv/alex/x") && out.includes("/srv/bob/y"), out);
}

console.log("7. No false match when followed by word char");
{
  const line = '{"x":"/Users/alex/project2"}';
  const out = applyLine(line, [compile({ from: "/Users/alex/proj", to: "/srv/x" })]);
  check("project2 untouched", !out.includes("/srv/x"), out);
}

console.log("8. End-of-line boundary");
{
  const line = '{"cwd":"/Users/alex/proj"}';
  const out = applyLine(line, [compile({ from: "/Users/alex/proj", to: "/srv/proj" })]);
  check("eol boundary ok", out.includes('"/srv/proj"'), out);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
