const express = require('express');
const passport = require('passport');
const { Strategy } = require('passport-discord-auth');
const config = require('../../config');

const router = express.Router();

function setupPassport() {
  passport.use(new Strategy({
    clientId: config.discord.clientId,
    clientSecret: config.discord.clientSecret,
    callbackUrl: config.discord.callbackUrl,
    scope: ['identify', 'guilds'],
  }, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
  }));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((obj, done) => done(null, obj));
}

router.get('/discord', passport.authenticate('discord'));

router.get('/discord/callback',
  (req, res, next) => {
    passport.authenticate('discord', (err, user, info) => {
      if (err) {
        return res.redirect('/');
      }
      if (!user) {
        return res.redirect('/');
      }
      req.logIn(user, (loginErr) => {
        if (loginErr) {
          return res.redirect('/');
        }
        res.redirect('/dashboard');
      });
    })(req, res, next);
  }
);

router.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

module.exports = { router, setupPassport };
