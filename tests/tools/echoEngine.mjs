// A stand-in engine for the judge's own tests: it answers every NDJSON input line
// with that text unchanged, so its output is as large as its input.
import process from "node:process";

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  const out = [];
  for (const line of data.split("\n"))
    if (line.length > 0) out.push(JSON.stringify({ text: JSON.parse(line), status: "ok" }));
  process.stdout.write(out.map((l) => `${l}\n`).join(""));
});
