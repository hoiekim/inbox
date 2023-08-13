const toJson = async (r) => {
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
      });
      if (healthStatus < 200 || 300 <= healthStatus) throw new Error();
    } catch (err) {
      console.info(
        "Healthcheck falied, restarting initialization in 10 seconds."
      );
      return new Promise((res, rej) =>
        setTimeout(() => res(this.initialize(schema)), 10000)
      );
    }

    try {
      // Check if the index to initialize already exists
      const indexExists = await fetch(`${HOST}/${INDEX}`, {
        method: "HEAD",
        headers: {
          Authorization,
          "content-type": "application/json"
        }
      }).then((r) => r.status === 200);

      if (indexExists) {
        // Define mappings to the index
        await this.request("_mapping", "PUT", {
          properties: schema
        });
      } else {
        // Create index with mappings
        await this.request("", "PUT", {
          mappings: { properties: schema }
        });
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

    return fetch(`${HOST}/${INDEX}/${path}`, options).then(toJson);
  };
}

export default Elastic;
