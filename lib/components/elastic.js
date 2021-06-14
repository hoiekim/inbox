const fetch = require("node-fetch");

function Elastic(HOST, USERNAME, PASSWORD, INDEX) {
  const Authorization =
    "Basic " + Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");

  this.initialize = async () => {
    console.info("Initializing index:", INDEX);
    await fetch(`${HOST}:/reindex`, {
      method: "POST",
      source: {
        index: INDEX
      },
      dist: {
        index: "temp-for-init"
      }
    });
    await this.request("", "DELETE");
    await this.request("", "PUT", {
      mappings: {
        properties: {
          attachments: { type: "object" },
          "cc.value.address": { type: "keyword" },
          date: { type: "date" },
          "from.value.address": { type: "keyword" },
          "to.value.address": { type: "keyword" },
          "envelopeFrom.address": { type: "keyword" },
          "envelopeTo.address": { type: "keyword" },
          html: { type: "text" },
          subject: { type: "text" }
        }
      }
    });
    await fetch(`${HOST}:/reindex`, {
      method: "POST",
      source: {
        index: "temp-for-init"
      },
      dist: {
        index: INDEX
      }
    });
    await fetch(`${HOST}:/temp-for-init`, { method: "DELETE" });
    console.info("Initialized index:", INDEX);
  };

  this.request = (path, method, body) => {
    const options = {
      method,
      headers: {
        Authorization,
        "content-type": "application/json"
      }
    };

    if (body) {
      if (typeof body === "string") {
        options.body = body;
      } else if (Array.isArray(body)) {
        options.body = body.map(JSON.stringify).join("\n") + "\n";
      } else if (typeof body === "object") {
        options.body = JSON.stringify(body);
      }
    }

    return fetch(`${HOST}:/${INDEX}/${path}`, options).then((r) => r.json());
  };
}

module.exports = Elastic;
