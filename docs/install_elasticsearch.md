All these instructions can be found in this [official guide](https://www.elastic.co/guide/en/elasticsearch/reference/7.9/deb.html) as well. We tested with Elasticsearch v7.9 on ubuntu.

If these instructions are outdated, please raise an issue or send us a Pull Request.

## 1. Install Elasticsearch

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

## 2. Start Elasticsearch

1. Enter these commands to start Elasticsearch automatically when the system boots up
   ```
   sudo /bin/systemctl daemon-reload
   sudo /bin/systemctl enable elasticsearch.service
   ```
2. Enter this command to start Elasticsearch
   ```
   sudo systemctl start elasticsearch.service
   ```

## 3. Setup Elasticsearch Password

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
