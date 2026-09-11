const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");

const {
  GwsClient,
  parsePanel,
  realDescription,
  isEmergency,
  channelOf,
  parseLcuNums,
} = require("./gws");

const LAYER = "hpl:douglas";
const NAMESPACE = "3f6a1c40-8c1e-4b5a-9d21-6e0b7c9a4d10";
const BATCH_SIZE = 100;

/**
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ sdk, config }) => {
  if (!config.baseUrl) {
    return NormalSdk.InvokeError("missing baseUrl");
  }
  if (!config.token && !config.password) {
    return NormalSdk.InvokeError("set either a password or an existing token");
  }

  const gws = new GwsClient(config, sdk.logEvent);
  try {
    await gws.ensureSession();
  } catch (err) {
    return NormalSdk.InvokeError(`login failed: ${err.message}`);
  }

  const lcuNums = parseLcuNums(config.lcuNums);

  let total = 0;
  let added = 0;
  let skipped = 0;

  for (const lcuNum of lcuNums) {
    let rows;
    try {
      rows = await gws.loadOutputs(lcuNum);
    } catch (err) {
      sdk.logEvent(`[douglas] LCU ${lcuNum}: LoadOutputs failed - ${err.message}`);
      continue;
    }

    if (rows.length === 0) {
      sdk.logEvent(`[douglas] LCU ${lcuNum}: no outputs returned, skipping`);
      continue;
    }
    total += rows.length;

    const deviceUuid = uuidv5(`${config.baseUrl}/lcu/${lcuNum}`, NAMESPACE);
    await postPoints(sdk, [
      {
        layer: LAYER,
        uuid: deviceUuid,
        parent_uuid: deviceUuid,
        name: `Douglas LCU ${lcuNum}`,
        point_type: "DEVICE",
        attrs: {
          "douglas/lcuNum": String(lcuNum),
          "douglas/baseUrl": config.baseUrl,
        },
      },
    ]);

    const points = [];
    for (const row of rows) {
      // Unassigned channels come back with no panel and onOff "Unknown".
      if (!row.panel || row.onOff === "Unknown") {
        skipped++;
        continue;
      }

      const isDimmer = row.outputType === "dimmer";
      const { name: panelName, location: panelLocation } = parsePanel(row.panel);
      const desc = realDescription(row);
      const emergency = isEmergency(row);
      const protocolId = `${lcuNum}:${row.fastId}`;

      points.push({
        layer: LAYER,
        uuid: uuidv5(`${config.baseUrl}/${protocolId}`, NAMESPACE),
        // Fall back to the address when the circuit was never named.
        name: desc ? `${desc} (${row.outputId})` : row.outputId,
        parent_uuid: deviceUuid,
        parent_name: `Douglas LCU ${lcuNum}`,
        protocol_id: protocolId,
        hpl_driver: LAYER,
        point_type: "POINT",
        attrs: {
          areaDescription: desc,
          "douglas/fastId": String(row.fastId),
          "douglas/lcuNum": String(lcuNum),
          "douglas/outputId": row.outputId || "",
          "douglas/outputType": row.outputType || "",
          // relay and dimmer for one circuit share this, e.g. both 18.1r
          // and 18.1d resolve to "18.1"
          "douglas/channel": channelOf(row),
          "douglas/panel": panelName,
          "douglas/panelLocation": panelLocation,
          "douglas/circuit": row.circuit || "",
          "douglas/emergency": emergency ? "true" : "false",
          // life-safety circuits are imported for visibility only
          "douglas/writable": emergency ? "false" : "true",
          units: isDimmer ? "percent" : "",
          searchTokens: [desc, row.outputId, panelName, row.circuit]
            .filter(Boolean)
            .join(" "),
        },
      });

      // Photocell state is real operational data on exterior circuits, where
      // it shows up as InActivatedPhotoMode.
      if (row.photoSensorStatus && row.photoSensorStatus !== "NotInPhotoMode") {
        points.push({
          layer: LAYER,
          uuid: uuidv5(`${config.baseUrl}/${protocolId}/photo`, NAMESPACE),
          name: `${desc || row.outputId} Photocell`,
          parent_uuid: deviceUuid,
          parent_name: `Douglas LCU ${lcuNum}`,
          protocol_id: `${protocolId}:photo`,
          hpl_driver: LAYER,
          point_type: "POINT",
          attrs: {
            areaDescription: desc,
            "douglas/fastId": String(row.fastId),
            "douglas/lcuNum": String(lcuNum),
            "douglas/outputId": row.outputId || "",
            "douglas/outputType": "photoSensor",
            "douglas/channel": channelOf(row),
            "douglas/panel": panelName,
            "douglas/writable": "false",
          },
        });
      }
    }

    await postPoints(sdk, points);
    added += points.length;
    sdk.logEvent(
      `[douglas] LCU ${lcuNum}: imported ${points.length} points from ${rows.length} rows`
    );
  }

  sdk.logEvent(
    `[douglas] import complete. ${added} points from ${total} rows, ${skipped} unassigned skipped`
  );
};

async function postPoints(sdk, points) {
  if (points.length === 0) return;
  for (let i = 0; i < points.length; i += BATCH_SIZE) {
    const batch = points.slice(i, i + BATCH_SIZE);
    const res = await fetch(`http://${process.env.NFURL}/api/v1/point/points`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: batch }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `point registration failed: HTTP ${res.status} ${detail.slice(0, 200)}`
      );
    }
  }
}
