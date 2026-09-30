// A stand-in engine for the judge's own tests: it answers every NDJSON input line
// with that text unchanged, so its output is as large as its input. It also
// answers with the kind it read, so a test can see that the kind reached the
// engine's side of the command line.
import process from "node:process";

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  const out = [];
  for (const line of data.split("\n")) {
    if (line.length === 0) continue;
    const { text, kind } = JSON.parse(line);
    out.push(JSON.stringify({ text, status: "ok", kind }));
  }
  process.stdout.write(out.map((l) => `${l}\n`).join(""));
});
