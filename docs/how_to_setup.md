If these instructions are outdated, please raise an issue or send us a Pull Request.

# How to Setup

You need these to use Inbox:

- A domain name
- A server to run Inbox (Backend & Frontend server)
- Elasticsearch (Database to save and query emails)

If you want to send emails using Inbox. You need a 3rd party email sending service.(Currently we're using [Sendgrid](https://sendgrid.com/))

For detailed instruction, please keep reading this document.

### Install Inbox

1. Clone this git repository
   ```
   git clone https://github.com/garageScript/inbox.git
   ```
2. Setup environment variables in `.env` file

   ```
   DOMAIN=                  // Domain name to use when sending mails.
   REACT_APP_DOMAIN=        // Domain name to display in front UI.

   SECRET=                  // Encoding secret for session data. Any value works.
   ADMIN_PW=                // Password to login to Inbox.

   ELASTIC_USERNAME=        // Elasticsearch credentials.
   ELASTIC_PASSWORD=        // Elasticsearch credentials.
   ELASTIC_HOST=            // Elasticsearch credentials.
   ELASTIC_INDEX=           // Elasticsearch credentials.

   SENDGRID_KEY=            // API key that is issued by sendgrid.
   ```

   Please keep reading this document to get required env values.

### Setup DNS Records

Make sure your domain's MX record points to the server you're running Inbox. In order to setup your MX record, check your DNS settings in your domain's provider.

- Exmaple (assuming your domain name is `domain.com` and your server ip is `0.0.0.0`):
  |Type|Name|Key|Meaning|
  |----|----|---|-------|
  |A|mail|0.0.0.0|It points request for `mail.domain.com` to `0.0.0.0`|
  |MX|@|mail.domain.com|It points emails sent to `*@domain.com` and `*@*.domain.com` to `mail.domain.com`|

In the example above, `A` record is pointing `mail.domain.com` to `0.0.0.0` and `MX` record is pointing emails to `mail.domain.com`. When some email is sent to `something@domain.com`, it will look up `domain.com`'s `MX` record and send the email data to where it points to. So it will be eventually delivered to `0.0.0.0`

### Get Elasticsearch

- Option 1
  It's such a pain to install & set up Elasticsearch. Sign up for [leardatabases](https://learndatabases.dev) and get Elasticsearch credentials in 1 second.

- Option 2
  If you want to have your own Elasticsearch in your device, refer [this document](install_elasticsearch.md).

### Setup Sendgrid

1. Go to [Sendgrid](https://sendgrid.com/) and make an account.
2. Go to [dashboard](https://app.sendgrid.com/guide/integrate/langs/nodejs) and get api key.
3. Copy api key and paste it in `.env` file.

If you want to use this app only for receiving mails, skip this step.

### Initialize Database & Run

1. Run `init.js` file.

   ```
   node init.js
   ```

   - When you run this file, your elasticsearch database will be initialized.
   - Which means all data in the specified index is cleared, and created with mapped keys.

2. Run the app

   ```
   (Production mode)
   sudo npm install --only=prod && sudo npm run start

   (Development mode)
   sudo npm install && sudo npm run dev
   ```

   - Default port number is 3004. So you can connect to Inbox at http://(your-server-ip):3004
