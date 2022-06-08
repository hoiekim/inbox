If these instructions are outdated, please raise an issue or send us a Pull Request.

# How to Setup

You need these to use Inbox:

- A domain name
- A server to run Inbox

If you want to send emails using Inbox. You need a 3rd party email sending service.(Currently we're using [Sendgrid](https://sendgrid.com/))

For detailed instruction, please keep reading this document.

## 1. Install Inbox

1. Clone this git repository
   ```
   git clone https://github.com/garageScript/inbox.git
   ```
2. Setup environment variables in `.env.development` and `.env.production` file

   ```
   DOMAIN=                  // Domain name to use when sending mails.
   APP_DOMAIN=              // Domain name that hosts inbox app.
   REACT_APP_DOMAIN=        // Domain name to display in app UI.

   SECRET=                  // Encoding secret for session data. Any value works.
   ADMIN_PW=                // Password to login to Inbox.

   SENDGRID_KEY=            // API key that is issued by sendgrid.
   ```

## 2. Setup DNS Records

Make sure your domain's MX record points to the server you're running Inbox. In order to setup your MX record, check your DNS settings in your domain's provider.

- Exmaple (assuming your domain name is `domain.com` and your server ip is `0.0.0.0`):
  |Type|Name|Key|Meaning|
  |----|----|---|-------|
  |A|mail|0.0.0.0|It points request for `mail.domain.com` to `0.0.0.0`|
  |MX|@|mail.domain.com|It points emails sent to `*@domain.com` and `*@*.domain.com` to `mail.domain.com`|

In the example above, `A` record is pointing `mail.domain.com` to `0.0.0.0` and `MX` record is pointing emails to `mail.domain.com`. When some email is sent to `something@domain.com`, it will look up `domain.com`'s `MX` record and send the email data to where it points to. So it will be eventually delivered to `0.0.0.0`

## 3. Setup Sendgrid

1. Go to [Sendgrid](https://sendgrid.com/) and make an account.
2. Go to [dashboard](https://app.sendgrid.com/guide/integrate/langs/nodejs) and get api key.
3. Copy api key and paste it in `.env` file.

If you want to use this app only for receiving mails, skip this step.

## 4. Run app

1. Production mode

   Make sure you have docker and docker-compose installed in your machine.

   ```
   docker-compose up
   ```

2. Development mode

   Set following values in `.env.development` file to tell inbox what Elasticsearch host to use in development. You can install and run it in your local machine by downloading it from their [official website](https://elastic.co). In this case your Elasticsearch hostname is usually `http://localhost:9200`.

   ```
   ELASTIC_HOST=            // Address starts with http or https that directs to Elasticsearch host
   ELASTIC_USERNAME=        // Elasticsearch username (if required by Elasticsearch host)
   ELASTIC_PASSWORD=        // Elasticsearch password (if required by Elasticsearch host)
   ELASTIC_INDEX=           // Elasticsearch index name (optional)
   ```

   Then run app using this command

   ```
   npm i
   npm run dev
   ```

## 5. Enjoy!

Default port number is 3004. So you can connect to Inbox at http://(your-server-ip):3004

For development mode, use port number 3000 instead.

Admin username is `admin`, password is equal to the value of environment variable called `ADMIN_PW`
