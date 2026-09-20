const json = process.argv.includes("--json");

process.stdout.write(json ? `${JSON.stringify({ status: "ready" })}\n` : "status: ready\n");
