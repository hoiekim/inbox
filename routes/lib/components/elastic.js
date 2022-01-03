const fetch = require("node-fetch");

const callback = async (r) => {
  if (r?.json) r = await r.json();
  if (r?.error) throw new Error(JSON.stringify(r.error));
  return r;
};

function Elastic(HOST, USERNAME, PASSWORD, INDEX) {
  const Authorization =
    USERNAME && PASSWORD
      ? "Basic " + Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")
      : null;

  this.initialize = async (schema) => {
    console.info("Initializing index:", INDEX);
    
    try {
      const healthStatus = await fetch(HOST, {
        headers: {
          Authorization,
          "content-type": "application/json"
        }
      })
      if (healthStatus !== 200) throw new Error()
    } catch (err) {
      console.info("Helathcheck falied, restarting in 10 seconds.")
      return new Promise((res, rej) => setTimeout(() => res(this.initialize(schema)), 10000))
    }
    
    try {
      // Bellow assumes that user has access authentication to "INDEX-*"
      const tempIndex = INDEX + "-temp-" + Math.floor(Math.random() * 10000);

      // Check if the index to initialize already exists
      const indexExists = await fetch(`${HOST}/${INDEX}`, {
        method: "HEAD",
        headers: {
          Authorization,
          "content-type": "application/json"
        }
      }).then((r) => r.status === 200);

      let dataExists = false;

      if (indexExists) {
        // Check if data exists in the index to initialize
        dataExists = await this.request("_search", "POST", {
          size: 0,
          query: {
            match_all: {}
          }
        })
          .then(callback)
          .then((r) => !!r.hits.total.value);

        if (dataExists) {
          // Move data to temporary index
          await fetch(`${HOST}/_reindex`, {
            method: "POST",
            headers: {
              Authorization,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              source: { index: INDEX },
              dest: { index: tempIndex }
            })
          }).then(callback);
        }

        // Delete the index to initialize
        await this.request("", "DELETE").then(callback);
      }

      // Define mappings to the index to initialize
      await this.request("", "PUT", {
        mappings: { properties: schema }
      }).then(callback);

      if (dataExists) {
        // Move data back from the temporary index
        await fetch(`${HOST}/_reindex`, {
          method: "POST",
          headers: {
            Authorization,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            source: { index: tempIndex },
            dest: { index: INDEX }
          })
        }).then(callback);

        // Delete temporary index
        await fetch(`${HOST}/${tempIndex}`, {
          method: "DELETE",
          headers: {
            Authorization,
            "content-type": "application/json"
          }
        }).then(callback);
      }

      console.info("Initialized index:", INDEX);
    } catch (err) {
      console.error("Initializing index has failed:", INDEX);
      console.error(err);
      throw new Error(err);
    }
  };

  this.request = (path, method, body) => {
    const options = {
      method,
      headers: {
        Authorization,
        User_Agent: "*",
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

    return fetch(`${HOST}/${INDEX}/${path}`, options).then(callback);
  };
}

module.exports = Elastic;
