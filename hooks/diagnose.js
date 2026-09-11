/**
 * Diagnostic hook. Does no work — reports what the NF application sandbox
 * actually provides, so we can stop guessing why outbound HTTP fails with
 * "Cannot read properties of undefined (reading 'emit')".
 *
 * Run it once, read the log, then delete it.
 */
module.exports = async ({ sdk, config }) => {
  const log = (s) => sdk.logEvent(`[diag] ${s}`);

  // --- runtime ------------------------------------------------------------
  log(`node ${process.version}  platform=${process.platform}`);
  log(`NFURL=${process.env.NFURL || "(unset)"}`);

  // --- what's available ---------------------------------------------------
  log(`typeof fetch: ${typeof fetch}`);
  log(`typeof AbortController: ${typeof AbortController}`);
  log(`typeof sdk.http: ${typeof sdk.http}`);
  if (sdk.http && typeof sdk.http === "object") {
    log(`sdk.http keys: ${Object.keys(sdk.http).join(", ")}`);
  }
  log(`sdk keys: ${Object.keys(sdk).join(", ")}`);

  for (const mod of ["http", "https", "net", "dns"]) {
    try {
      const m = require(mod);
      const shape = Object.keys(m).slice(0, 6).join(",");
      log(`require('${mod}') ok - ${shape}...`);
    } catch (e) {
      log(`require('${mod}') FAILED - ${e.message}`);
    }
  }

  // --- can we reach NF's own API? -----------------------------------------
  // If this fails too, the sandbox has no working sockets at all and the
  // problem is not specific to the Douglas host.
  const nfurl = process.env.NFURL ? `http://${process.env.NFURL}` : null;
  const targets = [
    ["NF API", nfurl ? `${nfurl}/api/v1/point/points?limit=1` : null],
    ["GWS root", config.baseUrl || null],
  ].filter(([, u]) => u);

  for (const [label, url] of targets) {
    // fetch
    try {
      const res = await fetch(url);
      log(`fetch ${label} -> HTTP ${res.status}`);
    } catch (e) {
      log(`fetch ${label} -> ${e.name}: ${e.message}`);
      if (e.cause) log(`   cause: ${e.cause.code || e.cause.message}`);
    }

    // node http
    try {
      const status = await new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === "https:" ? require("https") : require("http");
        const req = lib.request(
          {
            hostname: u.hostname,
            port: u.port || 80,
            path: u.pathname + u.search,
            method: "GET",
            timeout: 10000,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        req.end();
      });
      log(`node ${label} -> HTTP ${status}`);
    } catch (e) {
      log(`node ${label} -> ${e.message}`);
      if (e.stack) log(`   at ${e.stack.split("\n")[10] || e.stack.split("\n")[1]}`);
    }
  }

  // --- sdk.http against NF's own API --------------------------------------
  if (sdk.http) {
    try {
      const r = await (typeof sdk.http === "function"
        ? sdk.http("/api/v1/point/points?limit=1")
        : sdk.http.get("/api/v1/point/points?limit=1"));
      log(`sdk.http NF API -> ${typeof r} ${r && r.status ? r.status : ""}`);
      if (r && typeof r === "object") {
        log(`   result keys: ${Object.keys(r).slice(0, 8).join(", ")}`);
      }
    } catch (e) {
      log(`sdk.http NF API -> ${e.message}`);
    }
  }

  log("done");
};
