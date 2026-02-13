If these instructions are outdated, please raise an issue or send us a Pull Request.

# How to Setup

You need these to use Inbox:

- A domain name
- A server to run Inbox

If you want to send emails using Inbox. You need a 3rd party email sending service.(Currently we're using [Mailgun](https://mailgun.com))

For detailed instruction, please keep reading this document.

## 1. Install Inbox

1. Clone this git repository
   ```
   git clone https://github.com/garageScript/inbox.git
   ```
2. Copy `.env.example` file and name it `.env.local` then determine environment variables in `.env.local` file as following.

   ```
   EMAIL_DOMAIN             // Domain name to use when sending & receiving mails.
   APP_HOSTNAME             // Domain name that hosts inbox web app.

   SECRET                   // Encoding secret for session data. Any value works.
   ADMIN_PW                 // Password to login to Inbox as admin user.

   MAILGUN_KEY              // (optional) API key issued by Mailgun. Used to send emails.

   OPENAI_KEY               // (optional) API key issued by OpenAI. Used to get insight of emails.

   PUSH_VAPID_PUBLIC_KEY    // (optional) API key issued by Push. Used to send push notifications.
   PUSH_VAPID_PRIVATE_KEY   // (optional) API key issued by Push. Used to send push notifications.

   SSL_CERTIFICATE=         // (optional) SSL certificate file path. Used for TLS in IMAP server.
   SSL_CERTIFICATE_KEY=     // (optional) SSL certificate key file path. Used for TLS in IMAP server.
   ```

## 2. Setup DNS Records

Make sure your domain's MX record points to the server you're running Inbox. In order to setup your MX record, check your DNS settings in your domain's provider.

- Exmaple (assuming your domain name is `domain.com` and your server ip is `0.0.0.0`):
  |Type|Name|Key|Meaning|
  |----|----|---|-------|
  |A|mail|0.0.0.0|It points request for `mail.domain.com` to `0.0.0.0`|
  |MX|@|mail.domain.com|It points emails sent to `*@domain.com` and `*@*.domain.com` to `mail.domain.com`|

In the example above, `A` record is pointing `mail.domain.com` to `0.0.0.0` and `MX` record is pointing emails to `mail.domain.com`. When some email is sent to `something@domain.com`, it will look up `domain.com`'s `MX` record and send the email data to where it points to. So it will be eventually delivered to `0.0.0.0`

## 3. Setup Mailgun

1. Go to [Mailgun](https://mailgun.com) and follow instructions to get started.
2. Get the API key and paste it in `.env.local` file.

If you want to use this app only for receiving mails, skip this step.

## 4. Run app

1. Production mode

   Make sure you have docker and docker-compose installed in your machine.

   ```
   docker-compose up
   ```

2. Development mode

   Set following values in `.env.local` file to configure PostgreSQL for development. You can install and run PostgreSQL locally or use the docker-compose setup.

   ```
   POSTGRES_HOST=localhost  // PostgreSQL host address
   POSTGRES_PORT=5432       // PostgreSQL port
   POSTGRES_USER=postgres   // PostgreSQL username
   POSTGRES_PASSWORD=inbox  // PostgreSQL password
   POSTGRES_DATABASE=inbox  // PostgreSQL database name
   ```

   Then run app using this command

   ```
   npm i
   npm run dev
   ```

### Environment Variables

This app in default uses `.env` and `.env.local` to load environment variables. `.env` is included in the repository, intending to determine consistent variables that are related to React's build process, etc. `.env.local` is not included in the repository, intending to determine variables that differ by inbox app's host environment, external API credentials, etc. Additionally, we have an option to add another one as `.env.<NODE_ENV>` where you can set `NODE_ENV` in your terminal for example in Mac/Linux, `NODE_ENV=development` or in Windows cmd, `set NODE_ENV=development`.

## 5. Enjoy!

Default port number is 3004. So you can connect to Inbox at http://(your-server-ip):3004

For development mode, use port number 3000 instead.

Admin username is `admin`, password is equal to the value of environment variable called `ADMIN_PW`
