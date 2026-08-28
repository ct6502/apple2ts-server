process.on("SIGTERM", () => {})
setInterval(() => {}, 1000)
process.stderr.write("test runner wedged\n")
