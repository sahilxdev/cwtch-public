const levels = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

export function createLogger(level = "info") {
  const threshold = levels[level] ?? levels.info;
  const write = (name, payload) => {
    if ((levels[name] ?? 100) < threshold) return;
    const record = {
      time: new Date().toISOString(),
      level: name,
      ...payload
    };
    const line = JSON.stringify(record);
    if (name === "error") console.error(line);
    else if (name === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (event, details = {}) => write("debug", { event, ...details }),
    info: (event, details = {}) => write("info", { event, ...details }),
    warn: (event, details = {}) => write("warn", { event, ...details }),
    error: (event, details = {}) => write("error", { event, ...details })
  };
}
