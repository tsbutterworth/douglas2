/**
 * Shared client for the Douglas Dialog Global Web Server (GWS).
 *
 * Single endpoint, JSON envelope, method dispatched by string:
 *
 *   POST /globalweb/W3000%20ISAPI%20Extension.DLL
 *   Content-Type: application/x-www-form-urlencoded   (body is raw JSON)
 *   Cookie: UserPermissionToken=<guid>; csrf=<token>
 *
 *   {"webapp":{"method":"LoadOutputs","LCUNum":1,
 *              "param":[{"token":"<guid>"},{"start":0},{"records":100}]}}
 *
 * The token travels in BOTH the cookie and the body. Omit either and the
 * DLL will hand back a redirectURL to the login page instead of data.
 *
 * The login page only ever writes UserPermissionToken, so the `csrf` cookie
 * seen alongside it in a browser almost certainly belongs to another app on
 * the same host (a Niagara station, in the case this was captured from).
 * It is kept as an optional config in case some page does set one.
 */

const axios = require("axios");

const PATH = "/globalweb/W3000%20ISAPI%20Extension.DLL";

// Default page size for LoadOutputs. The UI uses 64; the server honours
// whatever it's given and reports the real total in `records`.
const PAGE_SIZE = 100;

// Dimmer channels are the matching relay's fastId plus this offset.
// Verified across DRC-2100, 2107A, 2107B, 2115, 2120 and 2D.
const DIMMER_OFFSET = 500;

// Circuits whose description marks them as life-safety. These are imported
// read-only and are never valid command targets.
const EMERGENCY_RE = /\bem(erg(ency)?)?\b\.?|\bem\.\s*l/i;

class GwsClient {
  constructor(config, logEvent) {
    this.baseUrl = (config.baseUrl || "").replace(/\/+$/g, "");
    this.token = config.token;
    this.csrf = config.csrf;
    this.username = config.username;
    this.password = config.password;
    this.log = logEvent || (() => {});
  }

  get url() {
    return this.baseUrl + PATH;
  }

  cookieHeader() {
    const jar = [`UserPermissionToken=${this.token}`];
    if (this.csrf) jar.push(`csrf=${this.csrf}`);
    return jar.join("; ");
  }

  /**
   * Low-level POST of a webapp envelope. `sendCookie` is false during login,
   * before a token exists.
   */
  async post(body, sendCookie = true) {
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "*/*",
      Origin: this.baseUrl,
      Referer: this.baseUrl + "/globalweb/",
    };
    if (sendCookie) headers.Cookie = this.cookieHeader();

    const res = await axios.post(this.url, JSON.stringify(body), {
      headers,
      timeout: 30000,
    });

    // Responses are JSON but the DLL does not always set a JSON content type,
    // so axios may hand back a string.
    let data = res.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (e) {
        throw new Error(`unparseable response: ${data.slice(0, 200)}`);
      }
    }
    if (!data || !data.webapp) throw new Error("no webapp envelope in response");
    return data.webapp;
  }

  /**
   * Call a GWS method. `params` is the array of single-key objects the
   * endpoint expects after the token.
   */
  async call(method, lcuNum, params = [], retry = true) {
    const w = await this.post({
      webapp: {
        method,
        LCUNum: lcuNum,
        param: [{ token: this.token }, ...params],
      },
    });

    // Session expiry shows up as a redirectURL rather than a 401.
    if (w.redirectURL) {
      if (!retry) throw new Error(`${method}: session rejected, redirected to ${w.redirectURL}`);
      this.log("[douglas] session expired, re-authenticating");
      await this.login();
      return this.call(method, lcuNum, params, false);
    }
    if (w.responseMessage) {
      this.log(`[douglas] ${method}: ${w.responseMessage}`);
    }
    return w;
  }

  /**
   * Two-step login, mirroring what the login page's GetLogin() does.
   *
   *   1. ValidateLoginPassword (LCUNum 0) -> responseToken
   *   2. client stores the token in the UserPermissionToken cookie itself
   *   3. RequestLoginRedirect (LCUNum 0) -> redirectURL
   *
   * Note these two methods return their fields inside parameters[0], unlike
   * the data calls which put responseMessage/redirectURL on the envelope.
   *
   * Auth is a bare password, 32 chars max, sent in cleartext. There is no
   * username and no per-user identity on the session.
   */
  async login() {
    if (!this.password) {
      throw new Error(
        "GWS session invalid and no password configured. Set the password " +
          "option, or refresh the token option by hand."
      );
    }

    const w = await this.post(
      {
        webapp: {
          method: "ValidateLoginPassword",
          LCUNum: 0,
          param: [{ userPassword: this.password }],
        },
      },
      false
    );

    const p = (w.parameters && w.parameters[0]) || {};
    // messageType 300 is the error class used by the login page
    if (!p.responseToken || p.responseToken.length === 0) {
      throw new Error(
        `login rejected: ${p.responseMessage || "no token returned"}`
      );
    }

    this.token = p.responseToken;

    // The server appears to expect this second call to activate the session,
    // so make it even though we ignore the redirect target.
    const r = await this.post({
      webapp: {
        method: "RequestLoginRedirect",
        LCUNum: 0,
        param: [{ token: this.token }],
      },
    });
    const rp = (r.parameters && r.parameters[0]) || {};
    this.log(
      `[douglas] logged in, redirect target ${rp.redirectURL || "(none)"}`
    );

    return this.token;
  }

  /** Log in if no token was supplied in config. */
  async ensureSession() {
    if (!this.token) await this.login();
    return this.token;
  }

  /**
   * Full output list for one LCU, including names and addressing.
   *
   * Params are {start}, {rowNum}, {total} — note it is NOT {records}. The
   * response's `records` field is the grand total for the LCU, so page until
   * we've accumulated that many. The UI uses rowNum 64; larger works.
   */
  async loadOutputs(lcuNum, rowNum = PAGE_SIZE) {
    const rows = [];
    let total = 0;

    for (let guard = 0; guard < 200; guard++) {
      const w = await this.call("LoadOutputs", lcuNum, [
        { start: rows.length },
        { rowNum },
        { total },
      ]);
      const page = w.parameters || [];
      if (total === 0) total = parseInt(w.records, 10) || 0;
      rows.push(...page);

      // Stop on a short page as well as on reaching the total, so a wrong
      // or zero `records` can't spin us.
      if (page.length === 0 || page.length < rowNum) break;
      if (total > 0 && rows.length >= total) break;
    }
    return rows;
  }

  /**
   * Send ON / OFF / DVAL to one or more outputs on an LCU.
   *
   * Mirrors sendOutputCommand() in outputsList.htm. Two things to watch:
   * the outputs array uses capital-F `FastId` while every response returns
   * lowercase `fastId`, and `dval` is sent as an empty string (not omitted)
   * for ON and OFF.
   *
   * @param {number} lcuNum  zero-based; LCUNum 1 is labelled "LCU 2" in the UI
   * @param {string} command "ON" | "OFF" | "DVAL"
   * @param {Array} fastIds  one call can carry many outputs
   * @param {number} dval    0-100, required for DVAL
   */
  async relayControl(lcuNum, command, fastIds, dval = "") {
    const cmd = String(command).toUpperCase();
    if (!["ON", "OFF", "DVAL"].includes(cmd)) {
      throw new Error(`unknown command ${command}`);
    }
    if (!fastIds || fastIds.length === 0) {
      throw new Error("no outputs given");
    }

    let level = "";
    if (cmd === "DVAL") {
      level = parseInt(dval, 10);
      if (isNaN(level) || level < 0 || level > 100) {
        throw new Error(`dval must be 0-100, got ${dval}`);
      }
    }

    return this.call("RelayControl", lcuNum, [
      { command: cmd },
      { dval: String(level) },
      { outputs: fastIds.map((id) => ({ FastId: String(id) })) },
    ]);
  }

  /**
   * Status-only poll. Much lighter per row than LoadOutputs and returns the
   * whole LCU in one shot, so this is what the poll hook uses.
   */
  async loadPartialOutputs(lcuNum, rowNum = 512) {
    const w = await this.call("LoadPartialOutputs", lcuNum, [
      { page: 1 },
      { rowNum },
    ]);
    return w.parameters || [];
  }
}

/** Panel string arrives as "Panel Name: DRC-2100,  Panel Location: " */
function parsePanel(raw) {
  if (!raw) return { name: "", location: "" };
  const name = (raw.match(/Panel Name:\s*([^,]*)/) || [])[1] || "";
  const location = (raw.match(/Panel Location:\s*(.*)$/) || [])[1] || "";
  return { name: name.trim(), location: location.trim() };
}

/**
 * areaDescription falls back to the outputId when the circuit was never
 * named, so "18.2r" as a description means unnamed, not a name.
 */
function realDescription(row) {
  const d = (row.areaDescription || "").trim();
  if (!d || d === row.outputId) return "";
  return d;
}

function isEmergency(row) {
  return EMERGENCY_RE.test(realDescription(row));
}

/** "18.1r" -> "18.1" - the circuit shared by the relay and its dimmer. */
function channelOf(row) {
  return (row.outputId || "").replace(/[rd]$/, "");
}

function parseLcuNums(raw) {
  if (!raw) return [1];
  return String(raw)
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((n) => parseInt(n, 10))
    .filter((n) => !isNaN(n));
}

// Clients are cached at module scope, keyed by host. Hooks share a JavaScript
// runtime, so a hook that runs once per group (one dimmer per group) reuses a
// single logged-in session instead of authenticating on every invocation.
const _clients = {};

function getClient(config, logEvent) {
  const key = (config.baseUrl || "").replace(/\/+$/g, "");
  if (!_clients[key]) {
    _clients[key] = new GwsClient(config, logEvent);
  } else {
    // Keep the logger pointed at the current invocation.
    _clients[key].log = logEvent || (() => {});
  }
  return _clients[key];
}

/**
 * LCUNum is zero-based. outputsList.htm builds its caption as
 * parseInt(lcu_number,10)+1, so LCUNum 1 is the "LCU-02" in the dropdown.
 */
function lcuLabel(lcuNum) {
  return `LCU-${String(parseInt(lcuNum, 10) + 1).padStart(2, "0")}`;
}

module.exports = {
  GwsClient,
  getClient,
  parsePanel,
  realDescription,
  isEmergency,
  channelOf,
  parseLcuNums,
  lcuLabel,
  DIMMER_OFFSET,
  PAGE_SIZE,
};
