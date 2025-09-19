import { readFileSync } from "fs";
import { SMTPServer } from "smtp-server";

export const initializeSmtp = async () => {
  await new Promise<void>((res) => {
    const port = 25;
    const server = new SMTPServer({ secure: false });
    server.listen(port, () => {
      console.log(`SMTP server listening on port ${port}`);
      res();
    });
  });

  await new Promise<void>((res) => {
    const port = 465;
    const { SSL_CERTIFICATE, SSL_CERTIFICATE_KEY } = process.env;

    if (!SSL_CERTIFICATE || !SSL_CERTIFICATE_KEY) {
      console.warn("SMTP: SSL certificate not found.");
      res();
      return;
    }

    const tlsOptions = {
      key: readFileSync(SSL_CERTIFICATE_KEY),
      cert: readFileSync(SSL_CERTIFICATE)
    };

    const server = new SMTPServer({ secure: true, ...tlsOptions });
    server.listen(port, () => {
      console.log(`SMTP server listening on port ${port} over TLS`);
      res();
    });
  });

  return;
};
