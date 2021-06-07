If these instructions are outdated, please raise an issue or send us a Pull Request.

# How to Setup

You need these to use Inbox:

- Elasticsearch (Database to save and query emails)
- Inbox (Backend & Frontend server)
- A domain name

If you want to send emails using inbox. You need a 3rd party email sending service.(Currently we're using [Sendgrid](https://sendgrid.com/))

For detailed instruction, please keep reading this document.

### Install Elasticsearch

> Setting up Elasticsearch is such a pain. <br/>
> Sign up for [leardatabases](https://learndatabases.dev) and get Elasticsearch credentials in 1 second. <br/>
> If you want to have your own db in your device, keep reading. <br/>
> Otherwise, skip to `install inbox` chapter

This app uses Elasticsearch for database to save the email data. Refer this official site's install instruction [here](https://www.elastic.co/guide/en/elasticsearch/reference/7.9/deb.html)
or follow this steps. (Tested on Ubuntu)

1. Enter this command to import the Elasticsearch PGP key
   ```
   wget -qO - https://artifacts.elastic.co/GPG-KEY-elasticsearch | sudo apt-key add -
   ```
2. Enter these commands step by step to install Elasticsearch from APT repository
   ```
   sudo apt-get install apt-transport-https
   echo "deb https://artifacts.elastic.co/packages/7.x/apt stable main" | sudo tee /etc/apt/sources.list.d/elastic-7.x.list
   sudo apt-get update && sudo apt-get install elasticsearch
   ```

### Start Elasticsearch

1. Enter these commands to start Elasticsearch automatically when the system boots up
   ```
   sudo /bin/systemctl daemon-reload
   sudo /bin/systemctl enable elasticsearch.service
   ```
2. Enter this command to start Elasticsearch
   ```
   sudo systemctl start elasticsearch.service
   ```

### Setup Elasticsearch Password

By default, elasticsearch has no security. Since your email may contain sensitive data, you must enable security.

1. As root user, open `/etc/elasticsearch/elasticsearch.yml` and add this line to enable security
   ```
   xpack.security.enabled: true
   ```
2. Since your configuration changed, restart elastice search using this command
   ```
   sudo systemctl restart elasticsearch.service
   ```
3. Setup user passwords by running
   ```
   sudo /usr/share/elasticsearch/bin/elasticsearch-setup-passwords auto
   ```
4. Save the password for the user `elastic`. This will be used when you connect to your Elasticsearch

### Install Inbox

1. Clone this git repository
   ```
   git clone https://github.com/garageScript/inbox.git
   ```
2. Setup environment variables in `.env` file
   ```
   DOMAIN=                  // Domain name to use when sending mails.
   REACT_APP_DOMAIN=        // Domain name to display in front UI

   SECRET=                  // Value to encode session data. Any value works
   ADMIN_PW=                // Password that will be used to login to Inbox

   ELASTIC_USERNAME=        // Elasticsearch credentials
   ELASTIC_PASSWORD=        // Elasticsearch credentials
   ELASTIC_HOST=            // Elasticsearch credentials
   ELASTIC_INDEX=           // Elasticsearch credentials

   SENDGRID_KEY=            // API key that is issued by sendgrid and supposed to be used when sending email requests
   ```

### Setup Sendgrid

1. Go to [Sendgrid](https://sendgrid.com/) and make an account.
2. Go to [dashboard](https://app.sendgrid.com/guide/integrate/langs/nodejs) and get api key.
3. Copy and paste api key in `.env` file.

If you want to use this app only for receiving mails, skip this step.

### Setup MX Record

Make sure your domains MX record points to the server you're running Inbox. In order to setup your MX record, check your DNS settings in your domain's provider.

- Exmaple:
  |Type|Name|Key|
  |----|----|---|
  |A|mail|127.0.0.1|
  |MX|@|mail.domain.com|

  In the example above, `A` record is pointing `mail.domain.com` to `127.0.0.1` and `MX` record is pointing emails to `mail.domain.com`. When some email is sent to `something@domain.com`, it will look up `domain.com`'s `MX` record and send the email data to where it points to. So it will be eventually delivered to `127.0.0.1`

### Initialize Database & Run

1. Run `init.js` file.
   ```
   node init.js
   ```
   - When you run this file, it will initialize your elasticsearch database.
   - Which means it clear all data of mails index, and create it with mapped keys.
   - This will allow you to search the mail receiver's email address in elasticsearch.
2. Run the app

   ```
   (Production mode)
   sudo npm install --only=prod && sudo npm build && sudo npm start

   (Development mode with watch option)
   sudo npm install && sudo npm run dev
   ```

   - Default port number is 3004. So you can connect to inbox at http://(your server ip):3004
