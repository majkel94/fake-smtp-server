#!/usr/bin/env node
const SMTPServer = require('smtp-server').SMTPServer;
const simpleParser = require('mailparser').simpleParser;
const express = require("express");
const bodyParser = require('body-parser')
const basicAuth = require('express-basic-auth');
const path = require("path");
const _ = require("lodash");
const moment = require("moment");
const cli = require('cli').enable('catchall').enable('status');

const config = cli.parse({
  'smtp-port': ['s', 'SMTP port to listen on', 'number', 1025],
  'smtp-ip': [false, 'IP Address to bind SMTP service to', 'ip', '0.0.0.0'],
  'http-port': ['h', 'HTTP port to listen on', 'number', 1080],
  'http-ip': [false, 'IP Address to bind HTTP service to', 'ip', '0.0.0.0'],
  whitelist: ['w', 'Only accept e-mails from these adresses. Accepts multiple e-mails comma-separated', 'string'],
  max: ['m', 'Max number of e-mails to keep', 'number', 100],
  auth: ['a', 'Enable Authentication', 'string'],
  headers: [false, 'Enable headers in responses']
});

const whitelist = config.whitelist ? config.whitelist.split(',') : [];

let users = null;
if (config.auth && !/.+:.+/.test(config.auth)) {
    cli.error("Please provide authentication details in USERNAME:PASSWORD format");
    console.log(process.exit(1))
}
if (config.auth) {
  let authConfig = config.auth.split(":");
  users = {};
  users[authConfig[0]] = authConfig[1];
}

const mails = [];
const responseRules = {};

const server = new SMTPServer({
  authOptional: true,
  maxAllowedUnauthenticatedCommands: 1000,
  onMailFrom(address, session, cb) {
    if (whitelist.length == 0 || whitelist.indexOf(address.address) !== -1) {
      cb();
    } else {
      cb(new Error('Invalid email from: ' + address.address));
    }
  },
  onRcptTo(address, session, callback) {
    let err;

    let mailTo = address.address.toLowerCase()
    if (mailTo in responseRules) {
        responseRule = responseRules[mailTo]
        err = new Error(responseRule.message);
        err.responseCode = responseRule.responseCode;

        cli.info('Applying rule ' + responseRule.responseCode + ' ' + responseRule.message + ' for: ' + mailTo)
        responseRule.applyTimes -= 1
        if (responseRule.applyTimes == 0) {
            delete responseRules[mailTo]
         }
        return callback(err);
    }

    callback();
},
  onAuth(auth, session, callback) {
    cli.info('SMTP login for user: ' + auth.username);
    callback(null, {
      user: auth.username
    });
  },
  onData(stream, session, callback) {
    parseEmail(stream).then(
      mail => {
        cli.debug(JSON.stringify(mail, null, 2));

        mails.unshift(mail);

        //trim list of emails if necessary
        while (mails.length > config.max) {
          mails.pop();
        }

        callback();
      },
      callback
    );
  }
});

function formatHeaders(headers) {
  const result = {};
  for (const [key, value] of headers) {
    result[key] = value;
  }
  return result;
}

function parseEmail(stream) {
  return simpleParser(stream).then(email => {
    if (config.headers) {
      email.headers = formatHeaders(email.headers);
    } else {
      delete email.headers;
    }
    return email;
  });
}

server.on('error', err => {
  cli.error(err);
});

server.listen(config['smtp-port'], config['smtp-ip']);

const app = express();

app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

if (users) {
    app.use(basicAuth({
        users: users,
        challenge: true
    }));
}

const buildDir = path.join(__dirname, 'build');

app.use(express.static(buildDir));
app.use(bodyParser.json())

function emailFilter(filter) {
  return email => {
    if (filter.since || filter.until) {
      const date = moment(email.date);
      if (filter.since && date.isBefore(filter.since)) {
        return false;
      }
      if (filter.until && date.isAfter(filter.until)) {
        return false;
      }
    }

    if (filter.to && _.every(email.to.value, to => to.address !== filter.to)) {
      return false;
    }

    if (filter.from && _.every(email.from.value, from => from.address !== filter.from)) {
      return false;
    }

    return true;
  }
}

app.get('/api/emails', (req, res) => {
  res.json(mails.filter(emailFilter(req.query)));
});

app.delete('/api/emails', (req, res) => {
    mails.length = 0;
    res.send();
});

app.route('/api/rules')
  .get(function (req, res) {
    res.json(responseRules)
  })
  .delete(function (req, res) {
    responseRules = {};
    res.send();
  })
  .put(function (req, res) {
    var newRule = {responseCode:req.body.responseCode, message:req.body.message, applyTimes:req.body.applyTimes}
    responseRules[req.body.mailTo.toLowerCase()] = newRule
    cli.info('New response rule: ' + JSON.stringify(req.body))
    res.status(202).json(req.body)
  })

app.listen(config['http-port'], config['http-ip'], () => {
  cli.info("HTTP server listening on http://" + config['http-ip'] +  ":" + config['http-port']);
});

cli.info("SMTP server listening on " + config['smtp-ip'] + ":" + config['smtp-port']);
